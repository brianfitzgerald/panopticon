import { APIGatewayProxyHandler } from "aws-lambda";
import * as fs from "fs";
import * as launchChrome from "@serverless-chrome/lambda";
import * as request from "superagent";
import * as puppeteer from "puppeteer";

const config = {
  baseUrl: "https://www.mycarfax.com",
  routes: [
    {
      route: "/"
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

export const hello: APIGatewayProxyHandler = async (event, context) => {
  const chrome = await getChrome();

  const browser = await puppeteer.connect({
    browserWSEndpoint: chrome.endpoint
  });

  const page = await browser.newPage(); // and we go...

  await page.goto("https://www.google.com/");

  config.routes.forEach(route => {
    const url = `${config.baseUrl}${route.route}`;
    const filename = `${url}.png`;
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Yeet",
      input: event
    })
  };
};
