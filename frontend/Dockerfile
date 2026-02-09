FROM node:20-alpine AS builder

ARG VITE_CONTACT_EMAIL
ARG VITE_GITHUB_REPO_URL
ARG VITE_BASE_PATH=/
ARG VITE_API_BASE=/api
ENV VITE_CONTACT_EMAIL=$VITE_CONTACT_EMAIL
ENV VITE_GITHUB_REPO_URL=$VITE_GITHUB_REPO_URL
ENV VITE_BASE_PATH=$VITE_BASE_PATH
ENV VITE_API_BASE=$VITE_API_BASE
ARG VITE_APP_SUBTITLE
ENV VITE_APP_SUBTITLE=$VITE_APP_SUBTITLE

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
