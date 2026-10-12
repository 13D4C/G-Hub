# Deploying G-Hub to AWS

Built for an **AWS Academy Learner Lab**, which is why a few things look the way
they do: every role is `LabRole` (the account cannot create IAM roles), the region
is `us-east-1`, and no instance larger than `.large` is permitted.

## What it builds

```
                            Internet
                                |
                              ELB                    (public subnets)
                                |
                        EKS control plane
                                |
        +-----------------------+-----------------------+
        |  Availability zone A                          |  Availability zone B
        |  ----------------------------                 |  ---------------------------
        |  public subnet:  NAT Gateway                  |  public subnet:  NAT Gateway
        |  private subnet: EC2 node                     |  private subnet: EC2 node
        |                  (web + worker pods)          |                  (web + worker pods)
        +-----------------------+-----------------------+
                                |
                     Gateway VPC endpoints (free)
                                |
                     +----------+----------+
                     |                     |
                 DynamoDB                 S3
               (12 tables)          (private bucket)
```

Nodes sit in the private subnets and reach the internet through the NAT Gateways.
Nothing reaches a node directly; the only public ingress is the load balancer the
`web` Service creates.

`web` and `worker` run the **same image**. The only difference is
`TRANSCODE_INLINE`, which keeps ffmpeg off the CPU that answers health checks.

## First deploy

```bash
cp example.tfvars terraform.tfvars   # optional: Stripe, Google, a domain
./deploy.sh
```

Needs `terraform`, `aws`, `docker` and `kubectl` on PATH.

The first run takes about **15 minutes** — an EKS control plane is slow to come
up and the node group waits on it. Afterwards `./deploy.sh --app` redeploys code
in a couple of minutes.

## Tearing it down

```bash
./destroy.sh
```

It deletes the Kubernetes Service **first**. That matters: the load balancer
belongs to Kubernetes rather than to Terraform, so destroying the cluster around
it would leave an orphan billing by the hour. Then it empties the bucket, runs
`terraform destroy`, and checks the account for anything left behind — clusters,
instances, load balancers, NAT gateways, Elastic IPs, volumes, tables, buckets —
and tells you plainly whether the region is clean.

Run it at the end of every lab session.

## Everyday commands

```bash
aws eks update-kubeconfig --name g-hub --region us-east-1

kubectl -n g-hub get pods
kubectl -n g-hub logs -l app=web --tail=100 -f
kubectl -n g-hub logs -l app=worker --tail=100 -f
kubectl -n g-hub rollout restart deployment/web
```

## Known limits

**Google sign-in needs HTTPS.** Google rejects any OAuth redirect URI that is not
HTTPS (localhost aside), and this lab cannot issue a public certificate without a
domain you control — CloudFront, which would have supplied one for free, is denied
here. On plain HTTP, email/password sign-in works and Google sign-in does not.

**Uploads are buffered in memory.** `createVideo` reads the whole file before
writing it to S3, so a large upload wants that much memory in the pod. The web
pod's limit is 1Gi; raise it, or move uploads to a presigned PUT straight to S3.

**The feed index is a single partition.** Every video shares one `feedBucket`
value so the home page can read them in created order. Correct while uploads are
rare; shard that attribute if it ever stops being.

**Transcoding is slow.** The lab caps instances at `.large`, so the worker has
two vCPUs to give ffmpeg.

## Cost

Roughly **$0.31/hour** with the defaults:

| | |
|---|---|
| EKS control plane | $0.10/hr |
| 2 × t3.large nodes | $0.166/hr |
| 2 × NAT Gateway | $0.09/hr — set `nat_per_az = false` to halve it |
| Classic load balancer | $0.025/hr |
| DynamoDB, S3, gateway endpoints | pay-per-request, ~free at test volumes |

Nothing stops the meter except `./destroy.sh`.
