# UNIVERSAL-DRM
Implementation to get DASH TO HLS in nodejs with redis.
# How To Install
Please understand how this works first before attempting to try however the code will indicate the libraries required.

    sudo apt update && sudo apt upgrade -y
    sudo apt-get install npm gcc g++ make ffmpeg build-essential zip unzip redis-server git aria2 -y
    sudo npm install --global yarn
    sudo npm install --global pm2
    cd /home
    git clone https://github.com/DRM-Scripts/Universal-DRM
    cd /Universal-DRM
    sudo npm install
    sudo chmod -R 777 /home/Universal-DRM/

- add username & password details where required in env example file
   (.env.example) & rename .env
- edit panel user name details and add whitelisted ips in
   (src/server.js)

  ips=line13
  login details=line129 - (default details u=sinep p=sllab)
   
    pm2 --name Universal-DRM start npm -- start

browse to http://ipofserver:3001/secret/start.html or http://ipofserver:3001/secret/index.html & login with details set

for error logging run node src/server.js from inside Universal-DRM folder to see live logging

Credit: Neo - Orignal Version - https://github.com/Neo-1977/N0DE-DL
