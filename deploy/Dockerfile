# angou.hikamers.app — docs/ の単体HTMLを配るだけの静的サイト
FROM nginx:alpine
COPY docs/ /usr/share/nginx/html/
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
