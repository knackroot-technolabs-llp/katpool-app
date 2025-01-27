FROM ubuntu:latest

# Use an official PostgreSQL image as the base
FROM postgres:latest

# Install cron, curl, and Bun
RUN apt-get update && apt-get install -y cron curl unzip

# Use the official Node.js image as the base image
FROM node:20

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash && echo $(date +%s)

# Create a directory for the backup scripts and files
RUN mkdir -p /backup /app

# Copy the backup script into the container
COPY backup.sh /app/backup.sh
COPY cloudBackup.ts /app/cloudBackup.ts

# Give execution rights on the backup script
RUN chmod +x /app/backup.sh

# Add Bun to the PATH environment variable
ENV PATH="/root/.bun/bin:$PATH"

# Copy the package.json and bun.lockb files to the working directory
COPY package.json /app/

# Install dependencies
WORKDIR /app
RUN bun install --cwd /app
RUN bun upgrade --canary

# Create a crontab file
RUN echo "0 * * * * /app/backup.sh >> /var/log/cron.log 2>&1" > /etc/cron.d/backup-cron

# Install cron in the final image so crontab works
RUN apt-get update && apt-get install -y cron

# Apply cron job
RUN crontab /etc/cron.d/backup-cron

# Create a log file for cron jobs
RUN touch /var/log/cron.log

# Create the directory where the backups will be stored
VOLUME ["/backup"]

# Run the command on container startup
CMD ["sh", "-c", "printenv > /etc/environment; bun run /app/cloudBackup.ts & cron -f"]
