import { APIGatewayProxyHandler } from "aws-lambda";
import * as launchChrome from "@serverless-chrome/lambda";
import * as request from "superagent";
import * as puppeteer from "puppeteer";
import * as AWS from "aws-sdk";

const config = {
  baseUrl: "https://www.mycarfax.com",
  routes: [
    {
      route: ""
    },
    {
      route: "/help/faq"
    }
  ]
};

const getChrome = async () => {
  const chrome = await launchChrome();

  const response = await request
    .get(`${chrome.url}/json/version`)
    .set("Content-Type", "application/json");

  const endpoint = response.body.webSocketDebuggerUrl;

  return {
    endpoint,
    instance: chrome
  };
};

const getPicturePath = (baseUrl: string, route: string): string => {
  const url = `${config.baseUrl}${route}`;
  let path = url.split("//")[1];
  path = path.split("/").join(":");
  return path;
};

export const hello: APIGatewayProxyHandler = async (event, context) => {
  if (process.env.IS_OFFLINE) {
    var credentials = new AWS.SharedIniFileCredentials({
      profile: "cxd-development"
    });
    AWS.config.credentials = credentials;
  }

  const s3 = new AWS.S3();

  const chrome = await getChrome();

  const browser = await puppeteer.connect({
    browserWSEndpoint: chrome.endpoint
  });

  const page = await browser.newPage();

  const bucketName = "panopticon-photos";

  // take photos

  await Promise.all(
    config.routes.map(async route => {
      let path = getPicturePath(config.baseUrl, route.route);
      const url = `${config.baseUrl}${route}`;
      await page.goto(url);
      const screenshot = await page.screenshot({
        fullPage: true
      });
      const date = new Date().toISOString().split("T")[0];
      console.log(date);
      path = `${path}/${date}.png`;
      console.log(path);

      await s3
        .putObject({
          Bucket: bucketName,
          Key: path,
          Body: screenshot
        })
        .promise();
    })
  );

  // compare against previous day

  await Promise.all(
    config.routes.map(async route => {
      const url = `${config.baseUrl}${route.route}`;
      let path = url.split("//")[1];
      path = path.split("/").join(":");
      console.log(url);
      console.log(path);

      const picture = await s3
        .getObject({
          Bucket: bucketName,
          Key: path
        })
        .promise();

      console.log(picture.Body);
    })
  );

  await browser.close();

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Yeet",
      input: event
    })
  };
};
