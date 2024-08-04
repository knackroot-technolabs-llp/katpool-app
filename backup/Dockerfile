# Use an official PostgreSQL image as the base
FROM postgres:16.3

# Install cron
RUN apt-get update && apt-get install -y cron

# Create a directory for the backup scripts and files
RUN mkdir /backup

# Copy the backup script into the container
COPY backup.sh /backup/backup.sh

# Give execution rights on the backup script
RUN chmod +x /backup/backup.sh

# Create a crontab file
RUN echo "0 * * * * /backup/backup.sh" > /etc/cron.d/backup-cron

# Apply cron job
RUN crontab /etc/cron.d/backup-cron

# Create the directory where the backups will be stored
VOLUME ["/backup"]

# Run the command on container startup
CMD ["cron", "-f"]
