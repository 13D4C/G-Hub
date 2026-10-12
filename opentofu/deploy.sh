#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(cd .. && pwd)"

STAGE="all"
case "${1:-}" in
  --infra) STAGE="infra" ;;
  --app)   STAGE="app" ;;
  "")      ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

TOFU="${TOFU:-tofu}"
for tool in "$TOFU" aws docker kubectl; do
  command -v "$tool" >/dev/null || { echo "$tool not found in PATH" >&2; exit 1; }
done

aws sts get-caller-identity >/dev/null || {
  echo "AWS credentials are not working. In a Learner Lab they expire with the session." >&2
  exit 1
}

PHASES=()
record() { PHASES+=("$(printf '  %-22s %ss' "$1" "$2")"); }

INFRA=0
INIT=0
APPLY=0
BUILD=0
PUSH=0
ROLLOUT=0

if [ "$STAGE" != "app" ]; then
  INFRA=1
  echo "==> tofu init"
  t0=$SECONDS
  "$TOFU" init -input=false >/dev/null
  INIT=$((SECONDS - t0))

  echo "==> tofu apply (the EKS control plane takes ~10 minutes)"
  t0=$SECONDS
  "$TOFU" apply -auto-approve -input=false
  APPLY=$((SECONDS - t0))
fi

out() { "$TOFU" output -raw "$1"; }

REGION=$(out region)
CLUSTER=$(out cluster_name)
NS=$(out namespace)
ECR=$(out ecr_repository_url)
REGISTRY="${ECR%%/*}"
APP_URL=""

echo "==> kubeconfig"
aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION" >/dev/null

echo "==> waiting for nodes to register"
kubectl wait --for=condition=Ready nodes --all --timeout=600s

if [ "$STAGE" = "infra" ]; then
  kubectl get nodes
  if [ "$INFRA" -eq 1 ]; then
    record "tofu init" "$INIT"
    record "tofu apply" "$APPLY"
    record "total" "$SECONDS"
    echo
    echo "timings"
    printf '%s\n' "${PHASES[@]}"
  fi
  exit 0
fi

TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)-$(date +%H%M%S)"

echo "==> docker build"
t0=$SECONDS
docker build -t "$ECR:$TAG" -t "$ECR:latest" "$REPO_ROOT"
BUILD=$((SECONDS - t0))

echo "==> push to $ECR"
t0=$SECONDS
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker push "$ECR:$TAG"
docker push "$ECR:latest"
PUSH=$((SECONDS - t0))

BUCKET=$(out s3_bucket)
TABLE_PREFIX=$(out dynamodb_table_prefix)
WEB_REPLICAS=$(out web_replicas)
WORKER_REPLICAS=$(out worker_replicas)

render() {
  sed -e "s|__IMAGE__|$ECR:$TAG|g" \
      -e "s|__NAMESPACE__|$NS|g" \
      -e "s|__REGION__|$REGION|g" \
      -e "s|__S3_BUCKET__|$BUCKET|g" \
      -e "s|__TABLE_PREFIX__|$TABLE_PREFIX|g" \
      -e "s|__APP_URL__|$APP_URL|g" \
      -e "s|__WEB_REPLICAS__|$WEB_REPLICAS|g" \
      -e "s|__WORKER_REPLICAS__|$WORKER_REPLICAS|g" \
      "$1"
}

echo "==> applying manifests"
render k8s/00-namespace.yaml | kubectl apply -f -

kubectl -n "$NS" create secret generic app-secrets \
  --from-literal=SESSION_SECRET="$(out session_secret)" \
  --from-literal=STRIPE_SECRET_KEY="$(out stripe_secret_key)" \
  --from-literal=STRIPE_WEBHOOK_SECRET="$(out stripe_webhook_secret)" \
  --from-literal=GOOGLE_CLIENT_ID="$(out google_client_id)" \
  --from-literal=GOOGLE_CLIENT_SECRET="$(out google_client_secret)" \
  --dry-run=client -o yaml | kubectl apply -f -

render k8s/30-service.yaml | kubectl apply -f -

echo "==> waiting for the load balancer"
for _ in $(seq 1 60); do
  LB=$(kubectl -n "$NS" get svc web -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
  [ -n "$LB" ] && break
  sleep 10
done
[ -n "${LB:-}" ] || { echo "the load balancer never got a hostname" >&2; exit 1; }

APP_URL=$(out app_url_override)
[ -z "$APP_URL" ] && APP_URL="http://$LB"

for f in k8s/10-config.yaml k8s/20-web.yaml k8s/21-worker.yaml; do
  render "$f" | kubectl apply -f -
done

kubectl -n "$NS" rollout restart deployment/web deployment/worker

echo "==> waiting for the rollout"
t0=$SECONDS
kubectl -n "$NS" rollout status deployment/web --timeout=600s
kubectl -n "$NS" rollout status deployment/worker --timeout=600s
ROLLOUT=$((SECONDS - t0))

echo
kubectl -n "$NS" get pods

if [ "$INFRA" -eq 1 ]; then
  record "tofu init" "$INIT"
  record "tofu apply" "$APPLY"
fi
record "docker build" "$BUILD"
record "ecr push" "$PUSH"
record "k8s rollout" "$ROLLOUT"
record "total" "$SECONDS"

echo
echo "timings"
printf '%s\n' "${PHASES[@]}"

echo
echo "  app     $APP_URL"
echo "  pods    kubectl -n $NS get pods"
echo "  logs    kubectl -n $NS logs -l app=web --tail=100 -f"
echo
echo "  The load balancer takes another minute or two to pass its own health"
echo "  checks before $APP_URL answers."
if [[ "$APP_URL" == http://* ]]; then
  echo
  echo "  NOTE  HTTP only, so Google sign-in will not work: Google rejects any"
  echo "        redirect URI that is not HTTPS. Email and password sign-in works."
fi
