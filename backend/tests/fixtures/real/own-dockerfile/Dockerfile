FROM python:3.12-alpine
WORKDIR /site
COPY index.html ./
ENV PORT=3000
USER 65532
CMD ["sh", "-ec", "exec python3 -m http.server \"$PORT\" --bind 0.0.0.0"]
