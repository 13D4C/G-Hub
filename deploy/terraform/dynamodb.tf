# The 12 tables the app's DynamoDB repository layer reads (src/server/data/dynamo/client.ts),
# copied from terraform/storage.tf. Names are "<var.name>-<table>", which matches the app's
# default DYNAMODB_TABLE_PREFIX of "g-hub".

resource "aws_dynamodb_table" "video_likes" {
  name         = "${var.name}-video-likes"
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
  name         = "${var.name}-video-views"
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
  name         = "${var.name}-channel-subscriptions"
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
  name         = "${var.name}-ads"
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
  name         = "${var.name}-video-comments"
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
  name         = "${var.name}-membership-tiers"
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
  name         = "${var.name}-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "tips" {
  name         = "${var.name}-tips"
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
  name         = "${var.name}-video-purchases"
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
  name         = "${var.name}-subscription-invoices"
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
  name         = "${var.name}-ad-impressions"
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
  name         = "${var.name}-videos"
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

# These tables replace the generic pk/sk tables this stack first created. A key schema can't
# change in place, so each move becomes a destroy-then-create under one address, which keeps
# the four tables that keep their name (users, videos, tips, ads) from colliding with themselves.
moved {
  from = aws_dynamodb_table.t["users"]
  to   = aws_dynamodb_table.users
}
moved {
  from = aws_dynamodb_table.t["videos"]
  to   = aws_dynamodb_table.videos
}
moved {
  from = aws_dynamodb_table.t["membershiptiers"]
  to   = aws_dynamodb_table.membership_tiers
}
moved {
  from = aws_dynamodb_table.t["channelsubscriptions"]
  to   = aws_dynamodb_table.channel_subscriptions
}
moved {
  from = aws_dynamodb_table.t["subscriptioninvoices"]
  to   = aws_dynamodb_table.subscription_invoices
}
moved {
  from = aws_dynamodb_table.t["videopurchases"]
  to   = aws_dynamodb_table.video_purchases
}
moved {
  from = aws_dynamodb_table.t["tips"]
  to   = aws_dynamodb_table.tips
}
moved {
  from = aws_dynamodb_table.t["videolikes"]
  to   = aws_dynamodb_table.video_likes
}
moved {
  from = aws_dynamodb_table.t["videocomments"]
  to   = aws_dynamodb_table.video_comments
}
moved {
  from = aws_dynamodb_table.t["videoviews"]
  to   = aws_dynamodb_table.video_views
}
moved {
  from = aws_dynamodb_table.t["ads"]
  to   = aws_dynamodb_table.ads
}
moved {
  from = aws_dynamodb_table.t["adimpressions"]
  to   = aws_dynamodb_table.ad_impressions
}
