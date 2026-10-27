"""Import real footage into an existing session. Never infer training duration or RPE."""
import argparse
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import httpx
from arena.ingest import CATEGORIES, import_folder, inventory


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inbox',type=Path,default=ROOT/'训练视频投放')
    parser.add_argument('--session-id')
    parser.add_argument('--category',choices=sorted(CATEGORIES))
    parser.add_argument('--url',default='http://127.0.0.1:8000')
    parser.add_argument('--username',default='admin')
    parser.add_argument('--password-file',type=Path,default=ROOT/'data/admin-password.txt')
    parser.add_argument('--state-dir',type=Path,default=ROOT/'data/imports')
    parser.add_argument('--retry-failed',action='store_true')
    parser.add_argument('--list',action='store_true',help='List source files/categories without login or changes')
    args=parser.parse_args()
    if args.list:
        print(json.dumps(inventory(args.inbox,args.category),ensure_ascii=False,indent=2))
        return
    if not args.session_id:parser.error('--session-id must refer to an existing confirmed training session')
    url=urlsplit(args.url)
    if url.scheme!='https' and not (url.scheme=='http' and url.hostname in ('localhost','127.0.0.1','::1')):
        parser.error('Use HTTPS for remote workspaces')
    with httpx.Client(base_url=args.url.rstrip('/'),trust_env=False,timeout=httpx.Timeout(300,connect=15),follow_redirects=False) as client:
        login=client.post('/api/login',json={'username':args.username,'password':args.password_file.read_text().strip()})
        login.raise_for_status()
        client.headers['X-CSRF-Token']=login.json()['csrf']
        try:
            report=import_folder(client,args.inbox,args.session_id,args.state_dir,category=args.category,retry_failed=args.retry_failed,
                progress=lambda row:print(json.dumps(row,ensure_ascii=False),flush=True) if row['stage'] in ('preparing','uploading','submitted','failed') else None)
            args.state_dir.mkdir(parents=True,exist_ok=True)
            summary=args.state_dir/f'{args.session_id}-report.json'
            summary.write_text(json.dumps(report,ensure_ascii=False,indent=2))
            print(json.dumps({'report':str(summary),'imported':len(report['imported']),'pending':len(report['pending']),'failed':len(report['failed'])},ensure_ascii=False))
            if report['failed']:sys.exit(1)
        finally:
            client.post('/api/logout')


if __name__=='__main__':main()
