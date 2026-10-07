# Object storage

Typster stores project assets in any S3-compatible bucket through `ex_aws_s3`.
Production points at AWS S3 or a compatible endpoint via `S3_ENDPOINT`,
`S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`.

## Local and CI backend: RustFS

- Image: `rustfs/rustfs:1.0.1` (Apache-2.0, Docker Hub). `docker-compose.yaml`
  and `.devcontainer/docker-compose.yaml` run it as the `rustfs` service; CI
  starts the same image pinned by digest in the `tests` job.
- S3 API on port 9000, console on 9001 at `/rustfs/console/`.
- Default credentials `rustfsadmin` / `rustfsadmin`, overridable with the same
  `AWS_*` variables the app reads. The bucket is created on first upload.
- Health endpoint: `GET /health` returns 200.

Why not MinIO: the official `minio/minio` image is no longer pullable
anonymously from Docker Hub or quay.io, and the Bitnami legacy build is frozen
(see issue #150).

## Calls the code depends on

`put_bucket`, `put_object`, `put_object_copy` (project forks),
`delete_object`, `presigned_url` (GET). A missing bucket must answer
`404 NoSuchBucket` so `Typster.Assets` can create it and retry. All of these
were checked against RustFS 1.0.1 with the AWS CLI and the fork test suite.
