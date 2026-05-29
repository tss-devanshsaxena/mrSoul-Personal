/**
 * Jest setup — provide required env vars so config validation passes in tests.
 */
process.env.NODE_ENV = 'test';
process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? 'xoxb-test-token';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? 'test-signing-secret';
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? 'ghp_test_token';
process.env.GITHUB_OWNER = process.env.GITHUB_OWNER ?? 'test-org';
process.env.GITHUB_REPO = process.env.GITHUB_REPO ?? 'test-repo';
process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/ce-tech-automation-test';
process.env.TRACKER_TYPE = process.env.TRACKER_TYPE ?? 'mongodb_only';
