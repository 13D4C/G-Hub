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

aws sts get-caller-identity >/dev/null || {
  echo "AWS credentials are not working. In a Learner Lab they expire with the session." >&2
  exit 1
}

if [ "$STAGE" != "app" ]; then
  echo "==> terraform apply (the EKS control plane takes ~10 minutes)"
  "$TF" init -input=false >/dev/null
  "$TF" apply -auto-approve -input=false
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
  exit 0
fi

TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)-$(date +%H%M%S)"

echo "==> docker build"
docker build -t "$ECR:$TAG" -t "$ECR:latest" "$REPO_ROOT"

echo "==> push to $ECR"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker push "$ECR:$TAG"
docker push "$ECR:latest"

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

echo "==> waiting for the load balancer"
for _ in $(seq 1 60); do
  LB=$(kubectl -n g-hub get svc web -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
  [ -n "$LB" ] && break
  sleep 10
done
[ -n "${LB:-}" ] || { echo "the load balancer never got a hostname" >&2; exit 1; }

APP_URL=$(out app_url_override)
[ -z "$APP_URL" ] && APP_URL="http://$LB"

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
kubectl -n g-hub rollout status deployment/web --timeout=600s
kubectl -n g-hub rollout status deployment/worker --timeout=600s

echo
kubectl -n g-hub get pods
echo
echo "  app     $APP_URL"
echo "  pods    kubectl -n g-hub get pods"
echo "  logs    kubectl -n g-hub logs -l app=web --tail=100 -f"
echo
echo "  The load balancer takes another minute or two to pass its own health"
echo "  checks before $APP_URL answers."
if [[ "$APP_URL" == http://* ]]; then
  echo
  echo "  NOTE  HTTP only, so Google sign-in will not work: Google rejects any"
  echo "        redirect URI that is not HTTPS. Email and password sign-in works."
fi
