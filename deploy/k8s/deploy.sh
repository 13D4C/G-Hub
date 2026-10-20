#!/usr/bin/env bash
# Builds the image, pushes it to ECR and rolls it out to the g-hub namespace.
#
#   deploy/k8s/deploy.sh                 build, push, apply, restart
#   SKIP_BUILD=1 deploy/k8s/deploy.sh    re-apply config and secret, restart
#
# Needs the Learner Lab's current credentials in ~/.aws/credentials, plus docker, kubectl and
# terraform. Reads the ECR repository and cluster name from deploy/terraform's outputs.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
TF="$ROOT/deploy/terraform"
REGION=${AWS_REGION:-us-east-1}

ECR=$(terraform -chdir="$TF" output -raw ecr_url)
CLUSTER=$(terraform -chdir="$TF" output -raw cluster_name)
TAG="$(git -C "$ROOT" rev-parse --short HEAD)-$(date +%m%d%H%M)"

aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION" >/dev/null

if [[ -z ${SKIP_BUILD:-} ]]; then
  aws ecr get-login-password --region "$REGION" |
    docker login --username AWS --password-stdin "${ECR%%/*}"
  # The nodes are x86_64, and this may be an arm64 Mac.
  docker buildx build --platform linux/amd64 -t "$ECR:$TAG" -t "$ECR:latest" --push "$ROOT"
fi

kubectl apply -f "$HERE/namespace.yaml"
"$HERE/secret.sh"
kubectl apply -f "$HERE/config.yaml" -f "$HERE/web.yaml" -f "$HERE/worker.yaml"

# Pods read envFrom only at start, and :latest leaves the pod spec unchanged, so restart.
kubectl -n g-hub rollout restart deployment/web deployment/worker
kubectl -n g-hub rollout status deployment/web --timeout=10m
kubectl -n g-hub rollout status deployment/worker --timeout=10m
kubectl -n g-hub get pods -o wide
