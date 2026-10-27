"""Run without an input to open the local browser tool, or supply a file for CLI use."""
import argparse
import json
import shutil
import signal
import sys
import threading
import webbrowser
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from arena.video_prepare import PreparationCancelled, prepare_video, validate_limits


def existing_url(state_file, port, options):
    try:
        state = json.loads(state_file.read_text())
        if state.get('port') != port or state.get('options') != options or not isinstance(state.get('token'), str):
            return None
        url = f'http://127.0.0.1:{port}/'
        request = Request(url + 'api/authorize', data=b'', headers={'X-Arena-Token': state['token']})
        with build_opener(ProxyHandler({})).open(request, timeout=2) as response:
            if response.status == 200:
                return url + '#token=' + state['token']
    except (OSError, ValueError, KeyError):
        pass
    return None


def main():
    parser = argparse.ArgumentParser(description='Local Arena video preparation: originals stay unchanged.')
    parser.add_argument('input', nargs='?', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'data' / 'prepared')
    parser.add_argument('--max-mb', type=float, default=100, help='Output file limit, <=100 MiB')
    parser.add_argument('--max-seconds', type=float, default=300, help='Output duration limit, <=300 seconds')
    parser.add_argument('--overlap', type=float, default=2, help='Overlap between encoded clips')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-open', action='store_true', help='Do not launch the system browser')
    args = parser.parse_args()
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        parser.exit(2, 'Install FFmpeg (including ffprobe) first. / 请先安装 FFmpeg。\n')
    try:
        options = dict(max_bytes=int(args.max_mb * 1024**2), max_seconds=args.max_seconds, overlap=args.overlap)
        validate_limits(**options)
    except (ValueError, OverflowError) as exc:
        parser.exit(2, str(exc) + '\n')
    if args.input:
        cancel = threading.Event()
        signal.signal(signal.SIGINT, lambda *_: cancel.set())
        try:
            folder = prepare_video(args.input, args.output, cancel=cancel, **options)
        except (ValueError, OSError, PreparationCancelled) as exc:
            parser.exit(2, str(exc) + '\n')
        print(json.dumps({'folder': str(folder), 'manifest': str(folder / 'manifest.json')}, ensure_ascii=False))
        return
    from arena.prepare_server import make_server
    state_file = args.output / '.tool.json'
    url = existing_url(state_file, args.port, options)
    if url:
        print('Local video tool / 本机视频整理工具：' + url, flush=True)
        if not args.no_open:
            webbrowser.open(url)
        return
    try:
        server = make_server(args.output, port=args.port, prepare_options=options)
    except OSError as exc:
        parser.exit(2, f'Cannot start the local tool on port {args.port}: {exc}. Try --port 8766.\n')
    url = f'http://127.0.0.1:{server.server_port}/#token={server.token}'
    state_file.write_text(json.dumps({'port': server.server_port, 'token': server.token, 'options': options}))
    state_file.chmod(0o600)
    print('Local video tool / 本机视频整理工具：' + url, flush=True)
    print('Outputs / 输出文件夹：' + str(args.output.resolve()), flush=True)
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        try:
            if json.loads(state_file.read_text()).get('token') == server.token:
                state_file.unlink()
        except (OSError, ValueError):
            pass


if __name__ == '__main__':
    main()
