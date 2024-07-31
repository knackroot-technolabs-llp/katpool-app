#!/bin/bash

# Set the date format for the backup filename
DATE=$(date +\%Y\%m\%d\%H\%M)

# Define the backup directory
BACKUP_DIR="/backup/files"
mkdir -p $BACKUP_DIR

# Define the backup filename
BACKUP_FILE="$BACKUP_DIR/files/db_backup_$DATE.tar.gz"

# Perform the backup using pg_dumpall and compress it
PGPASSWORD=$POSTGRES_PASSWORD pg_dumpall -h $POSTGRES_HOSTNAME -U $POSTGRES_USER | gzip > $BACKUP_FILE

# Print a message
echo "Backup completed: $BACKUP_FILE"
