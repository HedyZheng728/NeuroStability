"""Offline learned COCO17 -> H36M17 lifting using the official MotionBERT Lite.

This is a skeleton estimate in model space, not WHAM/SMPL, calibrated world
coordinates, global motion, or a measurement of athletic/medical ability.
"""
import hashlib
import importlib.util
import math
from pathlib import Path

SOURCE_REVISION = '705d3a95354db8bdb696b3492e47a3b5537174ff'
WEIGHT_REVISION = '370a9196aa3c89198b134c82476143b01c0fb32c'
WEIGHT_URL = ('https://huggingface.co/walterzhu/MotionBERT/resolve/' + WEIGHT_REVISION +
              '/checkpoint/pose3d/FT_MB_lite_MB_ft_h36m_global_lite/best_epoch.bin')
WEIGHT_SHA256 = '9811155371db4ca5d20f31a36a232d41012e12e1333882888a564d741861148f'
WEIGHT_BYTES = 64099897
METHOD_VERSION = 'motionbert-lite-h36m-global-coco17-v1'
JOINT_NAMES = ['pelvis', 'right_hip', 'right_knee', 'right_ankle', 'left_hip',
               'left_knee', 'left_ankle', 'spine', 'neck', 'nose', 'head_proxy',
               'left_shoulder', 'left_elbow', 'left_wrist', 'right_shoulder',
               'right_elbow', 'right_wrist']
EDGES = [[0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [5, 6], [0, 7], [7, 8],
         [8, 9], [9, 10], [8, 11], [11, 12], [12, 13], [8, 14], [14, 15], [15, 16]]
LIMITATIONS = [
    'Experimental monocular learned skeleton; depth is inferred, not directly measured.',
    'Root-relative model units: no calibrated metres, world position, global camera motion, or distance between people.',
    'COCO lacks the training Halpe head/neck/pelvis joints; these are documented 2D proxies. Wrestling, floor poses and occlusion may differ from training data.',
    'Track IDs are unverified tracklets, not athlete identity. Unknown occlusion stays unknown; 2D confidence is not 3D confidence.',
    'Input timestamps are preserved; temporal attention treats samples in a segment as equally spaced. Missing observations split segments; no missing 3D frames are invented.',
    'No mesh, true centre of mass, injury diagnosis, or competition ability is estimated.',
]


def checkpoint_path(settings):
    configured = str(getattr(settings, 'pose3d_model_path', '') or '').strip()
    if not configured:
        return None
    path = Path(configured).expanduser()
    return path / 'best_epoch.bin' if path.is_dir() else path


def checkpoint_verified(path):
    if path is None or not path.is_file() or path.stat().st_size != WEIGHT_BYTES:
        return False
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() == WEIGHT_SHA256


def pose3d_status(settings):
    dependencies = all(importlib.util.find_spec(name) is not None for name in ('torch', 'numpy'))
    path = checkpoint_path(settings)
    try:
        weights = checkpoint_verified(path)
    except OSError:
        weights = False
    ready = bool(dependencies and weights)
    return {'ready': ready, 'experimental': True, 'dependencies_installed': dependencies,
            'weights_installed': weights, 'device': 'cpu', 'model': 'MotionBERT Lite H36M',
            'license': 'Apache-2.0', 'method_version': METHOD_VERSION,
            'reason': ('官方 MotionBERT Lite 骨架权重已校验；CPU 推理，非世界坐标' if ready else
                       '需要 requirements-pose3d.txt 和 scripts/install_pose3d.py --download；配置 ARENA_POSE3D_MODEL')}


def coco_to_h36m(points):
    """Map actual COCO observations, with explicit virtual joint proxies.

    Limbs/nose are direct copies. Pelvis=mean(hips), neck=mean(shoulders),
    spine=mean(pelvis,neck), head_proxy=mean(eyes). Unlike Halpe26 these four
    joints are unavailable in COCO17. Their confidence is the minimum of their
    contributors, never an invented learned 3D confidence.
    """
    import numpy as np
    source = np.asarray(points, dtype=np.float32)
    if source.ndim != 3 or source.shape[1:] != (17, 3) or not np.isfinite(source).all():
        raise ValueError('COCO17 keypoints must have finite shape [frames,17,3]')
    result = np.empty_like(source)
    for dest, src in ((1, 12), (2, 14), (3, 16), (4, 11), (5, 13), (6, 15),
                      (9, 0), (11, 5), (12, 7), (13, 9), (14, 6), (15, 8), (16, 10)):
        result[:, dest] = source[:, src]
    for dest, src in ((0, [11, 12]), (8, [5, 6]), (10, [1, 2])):
        result[:, dest, :2] = source[:, src, :2].mean(axis=1)
        result[:, dest, 2] = source[:, src, 2].min(axis=1)
    result[:, 7, :2] = result[:, [0, 8], :2].mean(axis=1)
    result[:, 7, 2] = result[:, [0, 8], 2].min(axis=1)
    return result


def normalize_input(points):
    """Official crop_scale(...,[1,1]), over a single continuous person's segment.

    Source: MotionBERT lib/utils/utils_data.py at SOURCE_REVISION. The square
    bounding extent uses all nonzero-confidence joints, centres and scales xy
    to [-1,1], then clips all channels, including confidence, as upstream does.
    """
    import numpy as np
    result = np.array(points, dtype=np.float32, copy=True)
    valid = result[result[..., 2] != 0, :2]
    if len(valid) < 4:
        raise ValueError('Not enough nonzero-confidence joints for pose3d normalization')
    low, high = valid.min(axis=0), valid.max(axis=0)
    scale = float((high - low).max())
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError('Degenerate 2D skeleton cannot be normalized for pose3d')
    result[..., :2] = (result[..., :2] - (low + high) / 2) / scale * 2
    return np.clip(result, -1, 1)


def prepare_segments(pose, target_track_id=None):
    """Preserve exact source PTS; never bridge missing people or temporal gaps."""
    if pose.get('synthetic') is not False:
        raise ValueError('pose3d requires real observations, synthetic input is rejected')
    if pose.get('layout') != 'coco17':
        raise ValueError('pose3d requires COCO17 keypoints')
    if target_track_id is not None and (type(target_track_id) is not int or target_track_id < 0):
        raise ValueError('target track must be an integer track_id')
    tracks, skipped = {}, 0
    last_t = -math.inf
    sample_fps = pose.get('sample_fps', 10)
    max_gap = 1.75 / sample_fps if isinstance(sample_fps, (int, float)) and sample_fps > 0 else .175
    for index, frame in enumerate(pose.get('frames', [])):
        timestamp = frame.get('t')
        if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp) or timestamp < 0 or timestamp <= last_t:
            raise ValueError('pose3d requires strictly increasing finite source timestamps')
        last_t = timestamp
        seen = set()
        for person in frame.get('people', []):
            track = person.get('track_id')
            if type(track) is not int or track < 0:
                skipped += 1
                continue
            if target_track_id is not None and track != target_track_id:
                continue
            if track in seen:
                raise ValueError('Duplicate track_id in one source frame')
            seen.add(track)
            points = person.get('keypoints')
            if not isinstance(points, list) or len(points) != 17 or any(
                    not isinstance(point, list) or len(point) != 3 or any(
                        isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in point)
                    for point in points):
                raise ValueError('COCO17 keypoints must contain 17 finite [x,y,confidence] observations')
            segments = tracks.setdefault(track, [[]])
            previous = segments[-1][-1] if segments[-1] else None
            if previous and (index != previous['index'] + 1 or timestamp - previous['t'] > max_gap):
                segments.append([])
            segments[-1].append({'index': index, 't': timestamp, 'person': person})
    if not tracks:
        raise ValueError('No observations for the requested track; pose3d needs valid tracked people')
    return [segment for track in sorted(tracks) for segment in tracks[track]], skipped


def _flip(tensor):
    result = tensor.clone()
    result[..., 0] *= -1
    left, right = [4, 5, 6, 11, 12, 13], [1, 2, 3, 14, 15, 16]
    result[..., left + right, :] = result[..., right + left, :]
    return result


class Pose3DBackend:
    def __init__(self, settings):
        self.settings = settings
        self.model = None

    def load_model(self):
        if self.model is not None:
            return self.model
        path = checkpoint_path(self.settings)
        if path is None or not path.is_file():
            raise ValueError('Missing official pose3d weights: run scripts/install_pose3d.py --download and set ARENA_POSE3D_MODEL')
        if not checkpoint_verified(path):
            raise ValueError('MotionBERT checkpoint SHA256 does not match the pinned official weights')
        try:
            import torch
            from .vendor.motionbert.DSTformer import DSTformer
        except ImportError as exc:
            raise ValueError('Install requirements-pose3d.txt before pose3d inference') from exc
        # Explicit CPU avoids a second GPU model alongside the cached review LLM.
        torch.set_num_threads(min(torch.get_num_threads(), 4))
        checkpoint = torch.load(path, map_location='cpu', weights_only=True)
        model = DSTformer(dim_in=3, dim_out=3, dim_feat=256, dim_rep=512, depth=5,
                          num_heads=8, mlp_ratio=4, num_joints=17, maxlen=243, att_fuse=True)
        state = {key.removeprefix('module.'): value for key, value in checkpoint['model_pos'].items()}
        model.load_state_dict(state, strict=True)
        self.model = model.cpu().eval()
        return self.model

    def reconstruct(self, pose, metadata, progress, target_track_id=None):
        segments, skipped = prepare_segments(pose, target_track_id)
        progress(35, '校验官方 MotionBERT Lite 权重并加载 CPU 模型')
        model = self.load_model()
        import numpy as np
        import torch
        frames = {index: {'t': frame['t'], 'people': []} for index, frame in enumerate(pose['frames'])}
        chunks = sum(math.ceil(len(segment) / 243) for segment in segments)
        completed, observations = 0, 0
        with torch.inference_mode():
            for segment_index, segment in enumerate(segments):
                # Upstream WildDetDataset normalizes the full person's motion before
                # slicing into <=243 frame windows. It uses no temporal padding.
                inputs = normalize_input(coco_to_h36m([obs['person']['keypoints'] for obs in segment]))
                for offset in range(0, len(segment), 243):
                    block = inputs[offset:offset + 243]
                    tensor = torch.from_numpy(block).unsqueeze(0)
                    predicted = (model(tensor) + _flip(model(_flip(tensor)))) / 2
                    # Remove learned root translation explicitly; do not interpret
                    # global-lite root output as camera/world calibrated motion.
                    predicted = predicted - predicted[:, :, :1, :]
                    coordinates = predicted[0].cpu().numpy()
                    if coordinates.shape != block.shape or not np.isfinite(coordinates).all():
                        raise ValueError('MotionBERT produced invalid 3D coordinates')
                    for observation, joints in zip(segment[offset:offset + 243], coordinates):
                        person = observation['person']
                        quality = {'coco17_confidence': [p[2] for p in person['keypoints']],
                                   'mean_2d_confidence': sum(p[2] for p in person['keypoints']) / 17,
                                   'low_confidence_joint_count': sum(p[2] < .3 for p in person['keypoints']),
                                   'occlusion': 'unknown', 'depth_observed': False,
                                   'identity_verified': False, 'segment_index': segment_index,
                                   'short_segment': len(segment) < 27}
                        # Keep all upstream visibility/occlusion/prediction flags.
                        quality['upstream_flags'] = {key: value for key, value in person.items()
                                                     if key not in ('track_id', 'keypoints', 'bbox')}
                        frames[observation['index']]['people'].append(
                            {'track_id': person['track_id'], 'joints': joints.tolist(), 'source_quality': quality})
                        observations += 1
                    completed += 1
                    progress(40 + int(completed / chunks * 45), 'MotionBERT CPU 学习式三维骨架推理')
        output = [frame for frame in frames.values() if frame['people']]
        for frame in output:
            frame['people'].sort(key=lambda person: person['track_id'])
        return {'schema_version': 1, 'kind': 'pose3d', 'backend': 'pose3d', 'synthetic': False,
                'experimental': True, 'method_version': METHOD_VERSION, 'layout': 'h36m17',
                'coordinates': 'root_relative_model_space', 'unit': 'model_units',
                'joint_names': JOINT_NAMES, 'edges': EDGES, 'frames': output,
                'summary': {'frame_count': len(output), 'person_observation_count': observations,
                            'track_ids': sorted({p['track_id'] for f in output for p in f['people']}),
                            'segment_count': len(segments), 'skipped_untracked_observations': skipped},
                'provenance': {'model': 'MotionBERT Lite FT_MB_lite_MB_ft_h36m_global_lite',
                               'source_repository': 'https://github.com/Walter0807/MotionBERT',
                               'source_revision': SOURCE_REVISION, 'weight_source': WEIGHT_URL,
                               'model_sha256': WEIGHT_SHA256, 'license': 'Apache-2.0', 'device': 'cpu',
                               'input_backend': pose.get('backend'), 'input_model_sha256': pose.get('model_sha256'),
                               'input_tracking': pose.get('tracking'), 'timestamp_source': 'unchanged source pose frame t',
                               'normalization': 'official crop_scale([1,1]) per continuous track segment',
                               'coco_to_h36m': 'direct limbs/nose; pelvis=mean hips, neck=mean shoulders, spine=mean pelvis/neck, head_proxy=mean eyes',
                               'proxy_joint_indices': [0, 7, 8, 10], 'flip_augmentation': True,
                               'temporal_window_max': 243, 'temporal_padding': 'none; official variable-length inference',
                               'gap_policy': 'split at absent frame or >1.75 sample intervals; no interpolation',
                               'root_translation': 'subtract predicted pelvis xyz each frame'},
                'limitations': LIMITATIONS}
