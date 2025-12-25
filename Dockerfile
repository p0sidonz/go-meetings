FROM node:20-bullseye-slim

# Install dependencies for building mediasoup (Python 3, make, g++)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Expose HTTP port
EXPOSE 3000

# Expose Mediasoup UDP ports
EXPOSE 10000-10100/udp

CMD ["npm", "start"]
