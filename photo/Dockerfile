# The photo tool is a fully static WebGL app — nginx just serves the files.
# It is never exposed publicly; the gateway is the only thing that talks to it.
FROM nginx:alpine
COPY public /usr/share/nginx/html
EXPOSE 80
