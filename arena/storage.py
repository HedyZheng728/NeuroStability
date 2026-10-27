import shutil
from pathlib import Path, PurePosixPath


class LocalStore:
    def __init__(self, root):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, key):
        parts = PurePosixPath(key).parts
        if not parts or key.startswith("/") or ".." in parts or "\\" in key:
            raise ValueError("无效存储 key")
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("无效存储路径")
        return path

    def put(self, path, key, content_type="application/octet-stream"):
        dest = self.path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, dest)

    def download(self, key, dest):
        shutil.copyfile(self.path(key), dest)

    def delete_prefix(self, prefix):
        path = self.path(prefix)
        if path.is_dir():
            shutil.rmtree(path)


class S3Store:
    def __init__(self, settings):
        import boto3
        from botocore.config import Config
        self.bucket = settings.bucket
        self.client = boto3.client("s3", endpoint_url=settings.s3_endpoint or None,
                                   region_name=settings.s3_region,
                                   config=Config(signature_version="s3v4", connect_timeout=10, read_timeout=120,
                                                 s3={"addressing_style": "virtual"}))

    def put(self, path, key, content_type="application/octet-stream"):
        self.client.upload_file(str(path), self.bucket, key, ExtraArgs={"ContentType": content_type})

    def download(self, key, dest):
        self.client.download_file(self.bucket, key, str(dest))

    def url(self, key):
        return self.client.generate_presigned_url("get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=900)

    def delete_prefix(self, prefix):
        for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                self.client.delete_object(Bucket=self.bucket, Key=obj["Key"])


def make_store(settings):
    return S3Store(settings) if settings.bucket else LocalStore(settings.data_dir / "objects")
