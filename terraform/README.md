# Deploying G-Hub to AWS

Built for an **AWS Academy Learner Lab**, which is why a few things look the way
they do: every role is `LabRole` (the account cannot create IAM roles), the region
is `us-east-1`, and no instance larger than `.large` is permitted.

## What it builds

```
                            Internet
                                |
        clouddev.natthapong.net: Cloudflare NS -> Route 53 (dns/)
                                |
                     ALB + AWS WAF, HTTPS (ACM)      (public subnets)
                                |
                         NodePort 30080
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
Nothing reaches a node directly; the only public ingress is the ALB, which only the
ALB's security group may use to reach the nodes' NodePort. Plain HTTP on the ALB
only redirects to HTTPS.

The WAF (`waf.tf`) runs AWS's IP reputation list, the common rule set and the
known-bad-inputs set, plus a per-IP rate limit that leaves `/api/media/` out. The
common set's 8 KB body limit is set to count rather than block, or every video
upload would be refused.

`web` and `worker` run the **same image**. The only difference is
`TRANSCODE_INLINE`, which keeps ffmpeg off the CPU that answers health checks.

## Once: the domain

`dns/` is a separate stack holding the Route 53 zone for `clouddev.natthapong.net`
and its ACM certificate. `./destroy.sh` never touches it, so the zone keeps its
nameservers and Cloudflare is set up only once. It costs $0.50 a month.

The zone already exists, so it is imported rather than created:

```bash
cd dns
terraform init
terraform import aws_route53_zone.app Z07930312B7411JSYYDQH
terraform output cloudflare_ns_records
```

In Cloudflare, delete the existing `clouddev` record, then add the four NS records
that output lists (NS records cannot be proxied). Once
`dig NS clouddev.natthapong.net +short` returns the `awsdns` servers:

```bash
terraform apply    # waits until ACM has issued the certificate
```

## First deploy

```bash
cp example.tfvars terraform.tfvars   # optional: Stripe, Google
DOCKER_DEFAULT_PLATFORM=linux/amd64 ./deploy.sh
```

Needs `terraform`, `aws`, `docker` and `kubectl` on PATH, and `dns/` applied — the
app stack looks up its zone and certificate by name. On an Apple Silicon Mac the
platform variable matters: the nodes are x86, and an arm64 image fails to start
there with `exec format error`.

The first run takes about **15 minutes** — an EKS control plane is slow to come
up and the node group waits on it. Afterwards `./deploy.sh --app` redeploys code
in a couple of minutes.

## Tearing it down

```bash
./destroy.sh
```

It empties the bucket, runs `terraform destroy` — which takes the ALB, the WAF and
the Route 53 alias with it — and checks the account for anything left behind —
clusters, instances, load balancers, NAT gateways, Elastic IPs, volumes, tables,
buckets — and tells you plainly whether the region is clean. The zone and
certificate in `dns/` stay.

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

**The WAF can block a real user.** If a page or an upload answers 403, open the web
ACL's Sampled requests in the console to see which rule matched, and override that
rule to count in `waf.tf`. A classroom sharing one NAT address shares one rate
limit; raise `waf_rate_limit` for a demo.

**Uploads are buffered in memory.** `createVideo` reads the whole file before
writing it to S3, so a large upload wants that much memory in the pod. The web
pod's limit is 1Gi; raise it, or move uploads to a presigned PUT straight to S3.

**The feed index is a single partition.** Every video shares one `feedBucket`
value so the home page can read them in created order. Correct while uploads are
rare; shard that attribute if it ever stops being.

**Transcoding is slow.** The lab caps instances at `.large`, so the worker has
two vCPUs to give ffmpeg.

## Cost

Roughly **$0.32/hour** with the defaults:

| | |
|---|---|
| EKS control plane | $0.10/hr |
| 2 × t3.large nodes | $0.166/hr |
| 2 × NAT Gateway | $0.09/hr — set `nat_per_az = false` to halve it |
| Application load balancer | $0.0225/hr + capacity units |
| WAF web ACL + 4 rules | ~$0.0125/hr + $0.60 per million requests |
| DynamoDB, S3, gateway endpoints | pay-per-request, ~free at test volumes |
| Route 53 zone (`dns/`, kept) | $0.50/month |

Nothing stops the meter except `./destroy.sh`.
