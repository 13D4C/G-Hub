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

TF="${TERRAFORM:-terraform}"
for tool in "$TF" aws docker kubectl; do
  command -v "$tool" >/dev/null || { echo "$tool not found in PATH" >&2; exit 1; }
done

PHASES=()
record() { PHASES+=("$(printf '  %-22s %ss' "$1" "$2")"); }

INFRA=0
INIT=0
APPLY=0
BUILD=0
PUSH=0
ROLLOUT=0

aws sts get-caller-identity >/dev/null || {
  echo "AWS credentials are not working. In a Learner Lab they expire with the session." >&2
  exit 1
}

if [ "$STAGE" != "app" ]; then
  INFRA=1
  echo "==> terraform init"
  t0=$SECONDS
  "$TF" init -input=false >/dev/null
  INIT=$((SECONDS - t0))

  echo "==> terraform apply (the EKS control plane takes ~10 minutes)"
  t0=$SECONDS
  "$TF" apply -auto-approve -input=false
  APPLY=$((SECONDS - t0))
fi

out() { "$TF" output -raw "$1"; }

REGION=$(out region)
CLUSTER=$(out cluster_name)
ECR=$(out ecr_repository_url)
REGISTRY="${ECR%%/*}"

echo "==> kubeconfig"
aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION" >/dev/null

echo "==> waiting for nodes to register"
kubectl wait --for=condition=Ready nodes --all --timeout=600s

if [ "$STAGE" = "infra" ]; then
  kubectl get nodes
  if [ "$INFRA" -eq 1 ]; then
    record "terraform init" "$INIT"
    record "terraform apply" "$APPLY"
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

echo "==> applying manifests"
kubectl apply -f k8s/00-namespace.yaml

kubectl -n g-hub create secret generic app-secrets \
  --from-literal=SESSION_SECRET="$(out session_secret)" \
  --from-literal=STRIPE_SECRET_KEY="$(out stripe_secret_key)" \
  --from-literal=STRIPE_WEBHOOK_SECRET="$(out stripe_webhook_secret)" \
  --from-literal=GOOGLE_CLIENT_ID="$(out google_client_id)" \
  --from-literal=GOOGLE_CLIENT_SECRET="$(out google_client_secret)" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f k8s/30-service.yaml

APP_URL=$(out app_url_override)

render() {
  sed -e "s|__IMAGE__|$ECR:$TAG|g" \
      -e "s|__REGION__|$REGION|g" \
      -e "s|__S3_BUCKET__|$(out s3_bucket)|g" \
      -e "s|__TABLE_PREFIX__|$(out dynamodb_table_prefix)|g" \
      -e "s|__APP_URL__|$APP_URL|g" \
      -e "s|__WEB_REPLICAS__|$(out web_replicas)|g" \
      -e "s|__WORKER_REPLICAS__|$(out worker_replicas)|g" \
      "$1"
}

for f in k8s/10-config.yaml k8s/20-web.yaml k8s/21-worker.yaml; do
  render "$f" | kubectl apply -f -
done

kubectl -n g-hub rollout restart deployment/web deployment/worker

echo "==> waiting for the rollout"
t0=$SECONDS
kubectl -n g-hub rollout status deployment/web --timeout=600s
kubectl -n g-hub rollout status deployment/worker --timeout=600s
ROLLOUT=$((SECONDS - t0))

echo
kubectl -n g-hub get pods

if [ "$INFRA" -eq 1 ]; then
  record "terraform init" "$INIT"
  record "terraform apply" "$APPLY"
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
echo "  alb     $(out alb_dns_name)"
echo "  waf     $(out web_acl_name)  (blocked requests: console > WAF > Web ACLs > Sampled requests)"
echo "  pods    kubectl -n g-hub get pods"
echo "  logs    kubectl -n g-hub logs -l app=web --tail=100 -f"
echo
echo "  The load balancer takes another minute or two to pass its own health"
echo "  checks before $APP_URL answers."
