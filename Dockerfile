FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node lib ./lib
COPY --chown=node:node runtime ./runtime
COPY --chown=node:node web ./web
COPY --chown=node:node cli ./cli
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=4310 TERN_DATA_DIR=/data
EXPOSE 4310
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4310)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/main.mjs"]
