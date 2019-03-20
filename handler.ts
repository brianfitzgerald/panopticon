import { APIGatewayProxyHandler } from "aws-lambda";
import * as launchChrome from "@serverless-chrome/lambda";
import * as request from "superagent";
import * as puppeteer from "puppeteer";
import * as AWS from "aws-sdk";
const compare = require("resemblejs").compare;
import { WebClient } from "@slack/client";

type ResembleOutput = {
  isSameDimensions: boolean;
  dimensionDifference: { width: number; height: number };
  rawMisMatchPercentage: number;
  misMatchPercentage: string;
  diffBounds: { top: number; left: number; bottom: number; right: number };
  analysisTime: number;
  getImageDataUrl: [Function];
};

type RouteOutput = {
  route: string;
  baseURL: string;
  resembleOutput: ResembleOutput;
};

type PanopticonConfig = {
  site: ConfigObject;
  configs?: ConfigObject[];
};

type Route = {
  route: string;
  timeout?: number;
  delay?: number;
  compareThreshold?: number;
};

type ConfigObject = {
  baseURL: string;
  routes: Route[];
};

const exampleConfig: PanopticonConfig = {
  site: {
    baseURL: "https://www.mycarfax.com",
    routes: [
      {
        route: ""
      },
      {
        route: "/help/faq"
      }
    ]
  }
};

type Screen = AWS.S3.Body | Buffer;

// wrap the compare call because SOME LIBRARIES don't support promises for their callbacks
async function compareScreens(
  screen1: Screen,
  screen2: Screen,
  params: Object
): Promise<ResembleOutput> {
  return new Promise((resolve, reject) => {
    compare(
      screen1,
      screen2,
      {
        returnEarlyThreshold: 50
      },
      (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      }
    );
  });
}

// launch and return a headless chrome instance for puppeteer
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

// format the S3 picture key
const getPicturePath = (baseUrl: string, route: string): string => {
  const url = `${baseUrl}${route}`;
  let path = url.split("//")[1];
  path = path.split("/").join(":");
  return path;
};

// take a screenshot for each page
// compare against the previous day page
// return stats for each page
export const daily: APIGatewayProxyHandler = async (event, context) => {
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

  // TODO: add support for parsing multiple configs
  const activeConfig = exampleConfig.site;

  const allResults: RouteOutput[] = [];

  await Promise.all(
    activeConfig.routes.map(async route => {
      const path = getPicturePath(activeConfig.baseURL, route.route);
      const url = `${activeConfig.baseURL}${route.route}`;
      await page.goto(url);
      const screenshot = await page.screenshot({
        fullPage: true
      });
      const currentDayString = new Date().toISOString().split("T")[0];
      const currentDayPath = `${path}/${currentDayString}.png`;

      const previousDay = new Date();
      previousDay.setDate(previousDay.getDate() - 1);
      const previousDayString = previousDay.toISOString().split("T")[0];

      const previousDayPath = `${path}/${previousDayString}.png`;

      try {
        await s3
          .putObject({
            Bucket: bucketName,
            Key: currentDayPath,
            Body: screenshot
          })
          .promise();

        const previousDayScreenshot = await s3
          .getObject({
            Bucket: bucketName,
            Key: previousDayPath
          })
          .promise();

        if (!previousDayScreenshot.Body) {
          return;
        }

        const resembleOutput = await compareScreens(
          previousDayScreenshot.Body,
          screenshot,
          {
            returnEarlyThreshold: 50
          }
        );

        allResults.push({
          baseURL: activeConfig.baseURL,
          route: route.route,
          resembleOutput
        });
      } catch (e) {
        console.error(e);
      }
    })
  );

  let message = "Results:\n";
  allResults.forEach(r => {
    message += `${r.baseURL}${r.route}:\n`;
    const percentSimilar = 100 - parseInt(r.resembleOutput.misMatchPercentage);
    message += `${percentSimilar}% Similar\n`;
    if (percentSimilar < 50) {
      message += "Warning for this page\n";
    }
  });

  console.log(message);

  await browser.close();

  return {
    statusCode: 200,
    body: JSON.stringify({
      message,
      input: event
    })
  };
};
