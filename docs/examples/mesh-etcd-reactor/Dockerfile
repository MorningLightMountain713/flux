# etcd + the mesh reactor. Alpine ships etcd in community; busybox wget is
# already in the base image.
FROM alpine:3.20
RUN apk add --no-cache etcd etcd-ctl jq
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
