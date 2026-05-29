// MongoDB init script for Docker Compose (optional seed on first boot)
db = db.getSiblingDB('ce-tech-automation');
db.createCollection('issues');
db.createCollection('developermappings');
db.createCollection('dedupecaches');
print('CE-Tech Automation database initialized');
