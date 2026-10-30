#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

ASSUME_YES=0
[ "${1:-}" = "--yes" ] && ASSUME_YES=1

TF="${TERRAFORM:-terraform}"
command -v "$TF" >/dev/null || { echo "terraform not found; set TERRAFORM=/path/to/terraform" >&2; exit 1; }

if [ ! -f terraform.tfstate ] && [ ! -d .terraform ]; then
  echo "No Terraform state here — nothing was created from this directory."
  exit 0
fi

aws sts get-caller-identity >/dev/null || {
  echo "AWS credentials are not working, so nothing can be deleted." >&2
  exit 1
}

REGION=$("$TF" output -raw region 2>/dev/null || echo "us-east-1")
CLUSTER=$("$TF" output -raw cluster_name 2>/dev/null || echo "")
BUCKET=$("$TF" output -raw s3_bucket 2>/dev/null || echo "")

if [ "$ASSUME_YES" -ne 1 ]; then
  echo "This permanently deletes:"
  echo "  - every DynamoDB table (all accounts, videos, comments, payments)"
  [ -n "$BUCKET" ] && echo "  - the S3 bucket $BUCKET and every uploaded video in it"
  echo "  - the EKS cluster, its nodes, the load balancer, the WAF and the container images"
  echo "It keeps the Route 53 zone and certificate in dns/, so Cloudflare needs no change."
  echo
  read -r -p "Type the word destroy to continue: " reply
  [ "$reply" = "destroy" ] || { echo "Cancelled."; exit 1; }
fi

if [ -n "$CLUSTER" ] && command -v kubectl >/dev/null; then
  # The load balancer is Terraform's now (alb.tf), so there is nothing of Kubernetes' to wait
  # out; this only clears the namespace before the cluster goes.
  echo "==> deleting the Kubernetes namespace"
  aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION" >/dev/null 2>&1 || true
  kubectl delete -f k8s/30-service.yaml --ignore-not-found --timeout=180s 2>/dev/null || true
  kubectl delete namespace g-hub --ignore-not-found --timeout=180s 2>/dev/null || true
fi

if [ -n "$BUCKET" ]; then
  echo "==> emptying s3://$BUCKET"
  aws s3 rm "s3://$BUCKET" --recursive --region "$REGION" >/dev/null 2>&1 || true
fi

echo "==> terraform destroy (the cluster takes a few minutes)"
"$TF" destroy -auto-approve -input=false

echo
echo "==> checking for anything left behind"
LEFT=0
check() {
  local label="$1" found="$2"
  if [ -n "$found" ] && [ "$found" != "None" ]; then
    echo "  STILL THERE  $label: $found"
    LEFT=1
  else
    echo "  gone         $label"
  fi
}

check "EKS clusters"      "$(aws eks list-clusters --region "$REGION" --query 'clusters' --output text 2>/dev/null)"
check "EC2 instances"     "$(aws ec2 describe-instances --region "$REGION" --filters Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null)"
check "load balancers"    "$(aws elbv2 describe-load-balancers --region "$REGION" --query 'LoadBalancers[].LoadBalancerName' --output text 2>/dev/null)"
check "classic ELBs"      "$(aws elb describe-load-balancers --region "$REGION" --query 'LoadBalancerDescriptions[].LoadBalancerName' --output text 2>/dev/null)"
check "DynamoDB tables"   "$(aws dynamodb list-tables --region "$REGION" --query 'TableNames' --output text 2>/dev/null)"
check "S3 buckets"        "$(aws s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null)"
check "ECR repositories"  "$(aws ecr describe-repositories --region "$REGION" --query 'repositories[].repositoryName' --output text 2>/dev/null)"
check "NAT gateways"      "$(aws ec2 describe-nat-gateways --region "$REGION" --filter Name=state,Values=pending,available --query 'NatGateways[].NatGatewayId' --output text 2>/dev/null)"
check "Elastic IPs"       "$(aws ec2 describe-addresses --region "$REGION" --query 'Addresses[].AllocationId' --output text 2>/dev/null)"
check "EBS volumes"       "$(aws ec2 describe-volumes --region "$REGION" --query 'Volumes[].VolumeId' --output text 2>/dev/null)"
check "non-default VPCs"  "$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=false --query 'Vpcs[].VpcId' --output text 2>/dev/null)"

echo
echo "  kept         Route 53 zone and certificate in dns/ (\$0.50/month; terraform -chdir=dns destroy to drop)"

echo
if [ "$LEFT" -eq 0 ]; then
  echo "Everything is gone. Nothing in this region is still costing money."
else
  echo "Something survived — see above. Anything listed is still billable."
  echo "A load balancer, NAT gateway or Elastic IP left behind usually means"
  echo "terraform destroy stopped partway. Re-run this, or delete it in the console."
  exit 1
fi
