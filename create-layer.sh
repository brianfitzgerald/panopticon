git clone --depth=1 https://github.com/alixaxel/chrome-aws-lambda.git && \
cd chrome-aws-lambda && \
brotli --decompress --rm bin/chromium-*.br && \
npm pack && \
mkdir -p nodejs/node_modules/chrome-aws-lambda/ && \
tar --directory nodejs/node_modules/chrome-aws-lambda/ --extract --file chrome-aws-lambda-*.tgz --strip-components=1 && \
rm chrome-aws-lambda-*.tgz && \
npm install puppeteer-core --no-bin-links --no-optional --no-package-lock --no-save --no-shrinkwrap --prefix nodejs/ && \
zip -9 --filesync --move --recurse-paths _/chrome-aws-lambda.zip nodejs/
