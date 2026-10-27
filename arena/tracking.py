"""Scored person detections and ByteTrack tracklets; track IDs are not identities."""
from importlib.metadata import version
import numpy as np

METHOD = 'bytetrack-yolox-v1'


def decode_detections(outputs, *, ratio, input_size, width, height, labels=None):
    values = np.array(outputs, dtype=np.float32, copy=True)
    if values.ndim != 3 or values.shape[0] != 1 or values.shape[2] < 5 or not ratio > 0:
        raise ValueError('不支持的YOLOX输出布局')
    if values.shape[2] == 5:
        boxes, scores = values[0, :, :4] / ratio, values[0, :, 4]
        classes = np.zeros(len(scores)) if labels is None else np.asarray(labels).reshape(-1)
        if len(classes) != len(scores):
            raise ValueError('YOLOX类别与检测框数量不符')
    else:
        grids, scales = [], []
        for stride in (8,16,32):
            x,y = np.meshgrid(np.arange(input_size[1]//stride),np.arange(input_size[0]//stride))
            grid=np.stack((x,y),2).reshape(-1,2);grids.append(grid);scales.append(np.full((len(grid),1),stride))
        grid,scale=np.concatenate(grids),np.concatenate(scales)
        if len(grid)!=values.shape[1]:raise ValueError('YOLOX网格与输入尺寸不符')
        center=(values[0,:,:2]+grid)*scale
        size=np.exp(np.clip(values[0,:,2:4],-20,20))*scale
        boxes=np.concatenate((center-size/2,center+size/2),axis=1)/ratio
        scores=values[0,:,4]*values[0,:,5]  # COCO person class, not pose confidence
        classes=np.zeros(len(scores))
    valid=(np.isfinite(boxes).all(axis=1)&np.isfinite(scores)&(scores>=.1)&(scores<=1)&(classes==0)
           &(boxes[:,2]>boxes[:,0])&(boxes[:,3]>boxes[:,1]))
    boxes,scores=boxes[valid],scores[valid]
    boxes[:,[0,2]]=np.clip(boxes[:,[0,2]],0,width)
    boxes[:,[1,3]]=np.clip(boxes[:,[1,3]],0,height)
    valid=(boxes[:,2]-boxes[:,0]>=2)&(boxes[:,3]-boxes[:,1]>=2)
    boxes,scores=boxes[valid],scores[valid]
    if len(scores):
        from rtmlib.tools.object_detection.yolox import multiclass_nms
        found,_=multiclass_nms(boxes,scores[:,None],nms_thr=.45,score_thr=.099)
        boxes,scores=found[:,:4],found[:,4]
    return boxes.astype(np.float32).reshape(-1,4),scores.astype(np.float32)


def detect(detector, image):
    tensor,ratio=detector.preprocess(image)
    outputs=detector.inference(tensor)
    return decode_detections(outputs[0],ratio=ratio,input_size=detector.model_input_size,
                             width=image.shape[1],height=image.shape[0],labels=outputs[1] if len(outputs)>1 else None)


class PersonTracker:
    def __init__(self, sample_fps):
        from trackers import ByteTrackTracker
        self.tracker=ByteTrackTracker(frame_rate=sample_fps,track_activation_threshold=.6,
                                     high_conf_det_threshold=.5,minimum_consecutive_frames=2,
                                     minimum_iou_threshold=.1,lost_track_buffer=30)
        self.ids={}

    def update(self, boxes, confidence, timestamp=None):
        from supervision import Detections
        boxes=np.asarray(boxes,dtype=np.float32).reshape(-1,4)
        confidence=np.asarray(confidence,dtype=np.float32)
        if len(boxes)!=len(confidence):raise ValueError('检测框与置信度数量不符')
        detections=Detections(xyxy=boxes,confidence=confidence,data={'source_index':np.arange(len(boxes))})
        tracked=self.tracker.update(detections, timestamp=timestamp)
        assigned=[None]*len(boxes)
        for source,track_id in zip(tracked.data.get('source_index',[]),tracked.tracker_id):
            if track_id<0:continue
            raw=int(track_id)
            if raw not in self.ids:self.ids[raw]=len(self.ids)+1
            assigned[int(source)]=self.ids[raw]
        return assigned

    @property
    def provenance(self):
        return {'method_version':METHOD,'implementation':'roboflow/trackers','implementation_version':version('trackers'),
                'sample_rate_basis':'presentation timestamps','timestamp_source':'normalized_video_pts_seconds','minimum_detection_confidence':.1,
                'track_activation_threshold':.6,'high_conf_det_threshold':.5,'minimum_iou_threshold':.1,
                'minimum_consecutive_frames':2,'lost_track_buffer':30,'identity_verified':False}


def summarize(pose):
    tracks={};unassigned=0
    for frame in pose['frames']:
        for person in frame['people']:
            track_id=person.get('track_id')
            if not isinstance(track_id,int) or track_id<=0:
                unassigned+=1;continue
            row=tracks.setdefault(track_id,{'track_id':track_id,'start_sec':frame['t'],'end_sec':frame['t'],'observed_frames':0})
            row['end_sec']=frame['t'];row['observed_frames']+=1
    return {'method_version':METHOD,'track_count':len(tracks),'assigned_detections':sum(t['observed_frames'] for t in tracks.values()),
            'unassigned_detections':unassigned,'identity_verified':False,'tracks':list(tracks.values())}
