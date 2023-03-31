FROM node:19
EXPOSE 3000
COPY . /src
WORKDIR /src
RUN apt -y update; apt -y upgrade; apt -y install yarn
RUN yarn
RUN yarn build
ENTRYPOINT yarn start