#!/bin/bash
cd /home/lokhor/Documents/development/monrad-estimator-361-v13
cp -r ./* ~/Documents/development/monrad-estimator-361-v13-backup/ 2>/dev/null || echo "Note: Some files may not have been backed up"
echo "Backup created at ~/Documents/development/monrad-estimator-361-v13-backup"