# a09f self-service registration: Python stdlib HTTP service + sojuctl.
# sojuctl is copied from the exact soju image docker-compose runs, so the
# admin-socket protocol always matches the running bouncer.
ARG SOJU_IMAGE=codeberg.org/emersion/soju@sha256:c695fb996dce168fb39449415c7523b17189ed81b48c107d4728fc93fb30e799

FROM ${SOJU_IMAGE} AS soju

FROM python:3.12-alpine
COPY --from=soju /sojuctl /usr/local/bin/sojuctl
COPY app.py social.py /app/
EXPOSE 8080
CMD ["python3", "-u", "/app/app.py"]
