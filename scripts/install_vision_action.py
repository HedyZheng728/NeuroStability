#!/usr/bin/env python3
"""Explicit pinned official Qwen3-VL download; no training or model execution."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from arena.vision_action import MODEL_ID, MODEL_REVISION, MODEL_FILES, file_hash

CHUNK_BYTES = 32*1024*1024


def _https(request):
    if request.url.scheme != 'https':
        raise ValueError('视觉模型下载拒绝非 HTTPS 重定向')


def _range(directory, filename, number, start, end, total):
    import httpx
    path = directory/'ranges'/(filename+f'.{number:03}.part')
    expected = end-start+1
    url = f'https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}/{filename}'
    for attempt in range(10):
        try:
            have = path.stat().st_size if path.exists() else 0
            if have == expected:
                return path
            if have > expected:
                raise ValueError('本地下载分片超过官方长度')
            offset = start+have
            with httpx.Client(timeout=httpx.Timeout(120,connect=30),follow_redirects=True,event_hooks={'request':[_https]}) as client:
                with client.stream('GET',url,params={'arena_range':str(offset)},headers={'Range':f'bytes={offset}-{end}'}) as response:
                    response.raise_for_status()
                    if response.status_code != 206 or response.headers.get('content-range') != f'bytes {offset}-{end}/{total}':
                        raise ValueError('官方模型下载未返回要求的精确字节区间')
                    with path.open('ab') as target:
                        for chunk in response.iter_bytes(1024*1024):
                            if target.tell()+len(chunk) > expected:
                                raise ValueError('视觉模型分片超出官方长度')
                            target.write(chunk)
            if path.stat().st_size != expected:
                raise ValueError('视觉模型下载分片不完整')
            return path
        except (httpx.HTTPError,OSError,ValueError):
            if attempt == 9:
                raise
            time.sleep(2)


def install(directory, workers=16):
    import httpx
    directory.mkdir(parents=True,exist_ok=True)
    (directory/'ranges').mkdir(exist_ok=True)
    records = {}
    for filename,(size,_) in MODEL_FILES.items():
        path = directory/filename
        url = f'https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}/{filename}'
        if path.is_file():
            sha = file_hash(path,filename)
        elif filename.endswith('.safetensors'):
            specs = [(n,start,min(start+CHUNK_BYTES,size)-1) for n,start in enumerate(range(0,size,CHUNK_BYTES))]
            print(f'下载官方 {filename} ({size:,} bytes), {workers} 个并行 HTTPS 连接',flush=True)
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = [pool.submit(_range,directory,filename,n,a,b,size) for n,a,b in specs]
                for count,future in enumerate(as_completed(futures),1):
                    future.result()
                    if count%8 == 0 or count == len(specs):
                        print(f'已完成 {count}/{len(specs)} 个校验字节区间',flush=True)
            pending = directory/(filename+'.download')
            with pending.open('wb') as target:
                for number,_,_ in specs:
                    with (directory/'ranges'/(filename+f'.{number:03}.part')).open('rb') as source:
                        while chunk := source.read(4*1024*1024):
                            target.write(chunk)
            sha = file_hash(pending,filename)
            pending.replace(path)
            for number,_,_ in specs:
                (directory/'ranges'/(filename+f'.{number:03}.part')).unlink()
        else:
            pending = directory/(filename+'.download')
            with httpx.Client(timeout=httpx.Timeout(90,connect=30),follow_redirects=True,event_hooks={'request':[_https]}) as client:
                with client.stream('GET',url) as response:
                    response.raise_for_status()
                    with pending.open('wb') as target:
                        for chunk in response.iter_bytes(1024*1024):
                            if target.tell()+len(chunk)>size:
                                raise ValueError('视觉模型配置文件超出官方长度')
                            target.write(chunk)
            sha = file_hash(pending,filename)
            pending.replace(path)
        records[filename] = {'source_url':url,'size':size,'sha256':sha}
    manifest = {'model_id':MODEL_ID,'revision':MODEL_REVISION,'format':'safetensors','license':'Apache-2.0','files':records}
    pending = directory/'manifest.json.download'
    pending.write_text(json.dumps(manifest,indent=2)+'\n')
    pending.replace(directory/'manifest.json')
    (directory/'NOTICE').write_text(f'{MODEL_ID}, Qwen Team, Apache License 2.0.\nhttps://huggingface.co/{MODEL_ID}/tree/{MODEL_REVISION}\n')
    print('官方视觉模型及来源清单已校验；未加载模型，未运行推理。',flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download',action='store_true',help='显式授权约4.26 GB官方权重下载')
    parser.add_argument('--directory',type=Path,default=Path(__file__).resolve().parents[1]/'models/vision-action')
    parser.add_argument('--workers',type=int,choices=range(1,17),default=16)
    args = parser.parse_args()
    if not args.download:
        parser.error('需要 --download 才会联网；本脚本不运行模型')
    install(args.directory.resolve(),args.workers)


if __name__ == '__main__':
    main()
