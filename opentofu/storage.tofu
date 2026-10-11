resource "random_id" "bucket" {
  byte_length = 4
}

locals {
  media_bucket = "${var.project}-media-${random_id.bucket.hex}"
  table_prefix = var.project
}

resource "terraform_data" "media_bucket" {
  input = local.media_bucket

  provisioner "local-exec" {
    command = <<-EOT
      aws s3api create-bucket --bucket ${self.input} --region ${var.region} || true
      aws s3api put-public-access-block --bucket ${self.input} \
        --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    EOT
  }

  provisioner "local-exec" {
    when    = destroy
    command = "aws s3 rm s3://${self.input} --recursive || true; aws s3api delete-bucket --bucket ${self.input} || true"
  }
}

resource "aws_dynamodb_table" "video_likes" {
  name         = "${local.table_prefix}-video-likes"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "videoId"
  range_key    = "userId"

  attribute {
    name = "videoId"
    type = "S"
  }
  attribute {
    name = "userId"
    type = "S"
  }
}

resource "aws_dynamodb_table" "video_views" {
  name         = "${local.table_prefix}-video-views"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "viewerId"
  range_key    = "videoId"

  attribute {
    name = "viewerId"
    type = "S"
  }
  attribute {
    name = "videoId"
    type = "S"
  }
  attribute {
    name = "lastWatchedAt"
    type = "N"
  }

  local_secondary_index {
    name            = "by-last-watched"
    range_key       = "lastWatchedAt"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

resource "aws_dynamodb_table" "channel_subscriptions" {
  name         = "${local.table_prefix}-channel-subscriptions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "subscriberId"
  range_key    = "creatorId"

  attribute {
    name = "subscriberId"
    type = "S"
  }
  attribute {
    name = "creatorId"
    type = "S"
  }

  global_secondary_index {
    name            = "by-creator"
    hash_key        = "creatorId"
    range_key       = "subscriberId"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "ads" {
  name         = "${local.table_prefix}-ads"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
  attribute {
    name = "active"
    type = "S"
  }

  global_secondary_index {
    name            = "by-active"
    hash_key        = "active"
    range_key       = "id"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "video_comments" {
  name         = "${local.table_prefix}-video-comments"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
  attribute {
    name = "videoId"
    type = "S"
  }

  global_secondary_index {
    name            = "by-video"
    hash_key        = "videoId"
    range_key       = "id"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "membership_tiers" {
  name         = "${local.table_prefix}-membership-tiers"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
  attribute {
    name = "creatorId"
    type = "S"
  }

  global_secondary_index {
    name            = "by-creator"
    hash_key        = "creatorId"
    range_key       = "id"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "users" {
  name         = "${local.table_prefix}-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "tips" {
  name         = "${local.table_prefix}-tips"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "stripeSessionId"

  attribute {
    name = "stripeSessionId"
    type = "S"
  }
  attribute {
    name = "creatorId"
    type = "S"
  }

  global_secondary_index {
    name            = "by-creator"
    hash_key        = "creatorId"
    range_key       = "stripeSessionId"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "video_purchases" {
  name         = "${local.table_prefix}-video-purchases"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "stripeSessionId"

  attribute {
    name = "stripeSessionId"
    type = "S"
  }
  attribute {
    name = "creatorId"
    type = "S"
  }
  attribute {
    name = "buyerId"
    type = "S"
  }
  attribute {
    name = "videoId"
    type = "S"
  }

  global_secondary_index {
    name            = "by-creator"
    hash_key        = "creatorId"
    range_key       = "stripeSessionId"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "by-buyer"
    hash_key        = "buyerId"
    range_key       = "videoId"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "subscription_invoices" {
  name         = "${local.table_prefix}-subscription-invoices"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "stripeInvoiceId"

  attribute {
    name = "stripeInvoiceId"
    type = "S"
  }
  attribute {
    name = "creatorId"
    type = "S"
  }

  global_secondary_index {
    name            = "by-creator"
    hash_key        = "creatorId"
    range_key       = "stripeInvoiceId"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "ad_impressions" {
  name         = "${local.table_prefix}-ad-impressions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
  attribute {
    name = "creatorId"
    type = "S"
  }

  global_secondary_index {
    name            = "by-creator"
    hash_key        = "creatorId"
    range_key       = "id"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "videos" {
  name         = "${local.table_prefix}-videos"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
  attribute {
    name = "uploadedBy"
    type = "S"
  }
  attribute {
    name = "feedBucket"
    type = "S"
  }
  attribute {
    name = "createdAt"
    type = "N"
  }
  attribute {
    name = "requiredTierId"
    type = "S"
  }
  attribute {
    name = "transcodeStatus"
    type = "S"
  }
  attribute {
    name = "transcodeNextAttemptAt"
    type = "N"
  }

  global_secondary_index {
    name            = "by-creator"
    hash_key        = "uploadedBy"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "by-recency"
    hash_key        = "feedBucket"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "by-tier"
    hash_key        = "requiredTierId"
    range_key       = "id"
    projection_type = "KEYS_ONLY"
  }

  global_secondary_index {
    name            = "by-transcode"
    hash_key        = "transcodeStatus"
    range_key       = "transcodeNextAttemptAt"
    projection_type = "ALL"
  }
}
