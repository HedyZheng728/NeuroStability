"""One-shot folder ingestion through the authenticated Arena API; no generated data."""
import hashlib
import json
import os
from pathlib import Path

from .video_prepare import EXTENSIONS, UPLOAD_BYTES, UPLOAD_SECONDS, inspect_video, prepare_video

CATEGORY_FOLDERS = {'稳定性训练':'stability','步法训练':'footwork','进攻技术':'attack','防守技术':'defense',
                    'stability':'stability','footwork':'footwork','attack':'attack','defense':'defense',
                    '混合训练':'mixed','mixed':'mixed'}
CATEGORIES = {'stability','footwork','attack','defense','mixed'}


def _json(response):
    response.raise_for_status()
    return response.json()


def _sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source,'sha256').hexdigest()


def _save(path, value):
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    pending=path.with_suffix('.tmp')
    pending.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
    os.chmod(pending,0o600)
    pending.replace(path)


def inventory(inbox, default_category=None):
    if default_category is not None and default_category not in CATEGORIES:
        raise ValueError('Unknown training category')
    inbox=Path(inbox).resolve()
    if not inbox.is_dir():
        raise ValueError('Inbox directory does not exist')
    rows=[]
    for source in sorted(inbox.rglob('*')):
        if not source.is_file() or source.suffix.lower() not in EXTENSIONS or source.name.startswith('.'):
            continue
        relative=source.relative_to(inbox)
        category_set={CATEGORY_FOLDERS[part] for part in relative.parts[:-1] if part in CATEGORY_FOLDERS}
        category=next(iter(category_set)) if len(category_set)==1 else default_category if not category_set else None
        reason='File resolves outside the inbox' if not source.resolve().is_relative_to(inbox) else 'Training category needs confirmation' if category is None else ''
        rows.append({'path':str(source),'source':str(relative),'category':category,'pending':reason})
    return rows


def import_folder(client, inbox, session_id, state_dir, *, category=None, backend='rtmpose', retry_failed=False, progress=None):
    """Caller supplies an authenticated client and an existing, human-confirmed session."""
    if backend not in ('rtmpose','preprocess'):
        raise ValueError('Only real RTMPose or video preprocessing can be imported')
    sessions=_json(client.get('/api/sessions'))
    if not any(session['id']==session_id for session in sessions):
        raise ValueError('An existing, confirmed training session is required')
    state_dir=Path(state_dir).resolve()/session_id
    report={'session_id':session_id,'imported':[],'pending':[],'failed':[]}
    emit=progress or (lambda value:None)
    for row in inventory(inbox,category):
        if row['pending']:
            report['pending'].append(row)
            continue
        source=Path(row['path'])
        state,state_path=None,None
        try:
            source_sha=_sha(source)
            state_path=state_dir/f'{source_sha}.json'
            if state_path.exists():
                state=json.loads(state_path.read_text())
                if state['category']!=row['category']:
                    report['pending'].append({**row,'pending':'Category changed since the original import; review existing records first'})
                    continue
            else:
                state={'source':row['source'],'source_sha256':source_sha,'session_id':session_id,
                       'category':row['category'],'clips':[],'status':'preparing'}
                _save(state_path,state)
            emit({'stage':'preparing','source':row['source']})
            metadata=inspect_video(source)
            if metadata['size_bytes']<=UPLOAD_BYTES and metadata['duration_seconds']<=UPLOAD_SECONDS:
                # Stream the original directly. No extra local copy and no quality loss.
                artifacts=[{**metadata,'filename':source.name,'sha256':source_sha,'path':str(source),'mode':'copy',
                            'requested_start_sec':0,'requested_end_sec':metadata['video_duration_seconds']}]
            else:
                folder=Path(state['preparation']) if state.get('preparation') else None
                if folder is None or not (folder/'manifest.json').exists():
                    folder=prepare_video(source,state_dir/'prepared',progress=lambda value:emit({**value,'source':row['source']}))
                    state['preparation']=str(folder)
                    _save(state_path,state)
                manifest=json.loads((folder/'manifest.json').read_text())
                if manifest['status']!='complete' or manifest['source']['sha256']!=source_sha:
                    raise ValueError('Preparation manifest does not match the source')
                artifacts=[]
                for clip in manifest['clips']:
                    if Path(clip['filename']).name!=clip['filename']:
                        raise ValueError('Invalid prepared filename')
                    artifacts.append({**clip,'path':str(folder/clip['filename'])})
            for artifact in artifacts:
                path=Path(artifact['path'])
                if _sha(path)!=artifact['sha256'] or path.stat().st_size>UPLOAD_BYTES:
                    raise ValueError('Source/prepared file changed before upload')
                known=_json(client.get('/api/videos'))
                match=next((v for v in known if v['session_id']==session_id and v['sha256']==artifact['sha256']
                            and (artifact['mode']=='copy' or v['filename']==artifact['filename'])),None)
                if match is not None and match['category']!=row['category']:
                    raise ValueError('Matching video already has a different category; review it before importing')
                if match is None:
                    emit({'stage':'uploading','source':row['source'],'filename':artifact['filename']})
                    with path.open('rb') as video:
                        match=_json(client.post('/api/videos',data={'session_id':session_id,'category':row['category'],'authorized':'true'},
                            files={'file':(artifact['filename'],video,'application/octet-stream')}))
                entry={key:artifact[key] for key in ('filename','sha256','mode','requested_start_sec','requested_end_sec')}
                entry.update(video_id=match['id'],job_id=None)
                previous=next((c for c in state['clips'] if c['video_id']==match['id']),None)
                if previous is None:
                    state['clips'].append(entry)
                else:
                    entry=previous
                state['status']='uploaded'
                _save(state_path,state)
                jobs=_json(client.get(f"/api/videos/{match['id']}/report"))['jobs']
                job=next((job for job in jobs if job['backend']==backend),None)
                if job is None or (retry_failed and job['status'] in ('failed','blocked')):
                    job=_json(client.post(f"/api/videos/{match['id']}/jobs",json={'backend':backend}))
                entry.update(job_id=job['id'],job_status=job['status'])
                state['status']='submitted'
                state.pop('error',None)
                _save(state_path,state)
                item={'source':row['source'],'video_id':match['id'],'job_id':job['id'],'job_status':job['status'],
                      'category':row['category'],'mode':artifact['mode']}
                report['imported'].append(item)
                emit({'stage':'submitted',**item})
        except Exception as exc:
            error={'source':row['source'],'error':str(exc)}
            report['failed'].append(error)
            if state is not None and state_path is not None:
                state.update(status='failed',error=str(exc))
                _save(state_path,state)
            emit({'stage':'failed',**error})
    return report
