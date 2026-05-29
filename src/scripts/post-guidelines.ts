/**
 * Post + pin MrSoul guidelines in monitored channel(s).
 * Does not change channel topic/description (set those once in Slack UI).
 *
 * Usage: npm run slack:guidelines
 */
import dotenv from 'dotenv';
dotenv.config();

import { channelSetupService } from '../services/channelSetup';

channelSetupService
  .ensureChannelGuidelines()
  .then(() => {
    console.log('✅ MrSoul guidelines posted (or already pinned)');
    process.exit(0);
  })
  .catch(err => {
    console.error('Failed:', err);
    process.exit(1);
  });
