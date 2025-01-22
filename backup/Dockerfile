FROM ubuntu:latest

# Use an official PostgreSQL image as the base
FROM postgres:latest

# Install cron, curl, and Bun
RUN apt-get update && apt-get install -y cron curl && \
    curl -fsSL https://bun.sh/install | bash

# Create a directory for the backup scripts and files
RUN mkdir -p /backup /app

# Copy the backup script into the container
COPY backup.sh /backup/backup.sh
COPY cloudBackup.ts /app/cloudBackup.ts
COPY config.json /app/config.json
COPY google-credentials.json /app/google-credentials.json

# Give execution rights on the backup script
RUN chmod +x /backup/backup.sh

# Install dependencies for cloudBackup
RUN bun install --cwd /app

# Create a crontab file
RUN echo "0 * * * * /backup/backup.sh >> /var/log/cron.log 2>&1" > /etc/cron.d/backup-cron

# Apply cron job
RUN crontab /etc/cron.d/backup-cron

# Create a log file for cron jobs
RUN touch /var/log/cron.log

# Create the directory where the backups will be stored
VOLUME ["/backup"]

# Run the command on container startup
CMD ["sh", "-c", "printenv > /etc/environment; bun run /app/cloudBackup.ts & cron -f"]
