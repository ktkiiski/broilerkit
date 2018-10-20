# BroilerKit

**BroilerKit** is a framework for quickly developing web apps with modern technologies and deploying them to a scalable, production-ready environment! You can write your scripts in [TypeScript](http://www.typescriptlang.org/) and stylesheets in [SASS](http://sass-lang.com/), and they will be compiled into ES5 JavaScript and CSS using [Webpack](https://webpack.js.org/).

You deploy your production-ready web app to [Amazon Web Services cloud platform](https://aws.amazon.com/), with minimal setup and very low costs! The hosting is almost free (but not free) on low-traffic sites.

(**Disclaimer:** By using this utility you are taking the full responsibility for any incurring expenses.)

### Feature highlights

- Write all your code, both front-end and backend, in [TypeScript](http://www.typescriptlang.org/)
- Easily create a full-featured REST API as your backend and database models
- Easily add the user log in to your app with **Facebook and Google authentication**
- Write your stylesheets in [SASS](http://sass-lang.com/)
- No server maintenance: everything will run on [AWS platform](https://aws.amazon.com/) serverless solutions

### Other features

- Lint your JavaScript code style with [ESLint](http://eslint.org/)
- Lint your TypeScript code style with [TSLint](https://palantir.github.io/tslint/)
- Generate static HTML pages from [Pug](https://pugjs.org/) templates
- Polyfill `Promise`, `Symbol` and other ES6 features for browsers that do not support them
- Automatically bundle any images from your HTML, Pug, or Markdown files.
- Automatically **optimize images losslessly** for minimal size
- Include Markdown to your Pug templates. You may [include with filters](https://pugjs.org/language/includes.html#including-filtered-text) but `!= require("foo.md")` is preferred because it will also require any images.
- Generate favicons and related asset files from a single icon image file, and insert references to the HTML pages
- Refer to your current GIT version with `__COMMIT_HASH__`, `__VERSION__` and `__BRANCH__` constants

### Deployment features

- Deploy your compressed, production-ready web app to [AWS platform](https://aws.amazon.com/), hosted on [S3](https://aws.amazon.com/s3/), served globally through [CloudFront](https://aws.amazon.com/cloudfront/), and managed with [CloudFormation](https://aws.amazon.com/cloudformation/)
- Make your app available on your **custom domain** (_required_)
- Your app is served using **HTTPS**! Creation of required certificates are done automatically with [Amazon Certificate Manager](https://aws.amazon.com/certificate-manager/)
- Host static assets on separate cookieless domain with infinite caching, for maximum performance scoring and reliability
- Separate **stages** for your releases, e.g. the production version (`prod`) and the development version (`dev`)

## What do I need?

To use this utility, you need the following:

- Your own **domain** for your web app. You can buy one, e.g, from [GoDaddy](https://www.godaddy.com/domains).
- An [Amazon Web Services](https://aws.amazon.com/) account. You can get started with [AWS Free Tier](https://aws.amazon.com/free/).

## Installing

The BroilerKit-based projects are used with the [BroilerPan](https://github.com/ktkiiski/broilerpan) command line utility:

```bash
npm install -g broilerpan
```

## Creating a web app

To start developing a new web app, first create a GIT repository for it:

```bash
git init myapp
cd myapp
```

Then it is recommended that you apply the [Broilerplate template](https://github.com/ktkiiski/broilerplate.git) to your project:

```
broil init
```

If installing fails on OSX [you may try to install libpng with Homebrew](https://github.com/tcoopman/image-webpack-loader#libpng-issues).


## Configuring the app

Remember to add your project metadata to the `package.json`, for example, `name`, `author`, `description`.

You should change the configuration in `app.config.ts` according to your web app's needs.

- `name`: A distinct name of your app. Recommended to be in lower case and separate words with dashes, because the name will be used in Amazon resource names and internal host names.
- `stages`: Configuration for each different stage that your app has. By default there are `dev` stage for a development version and `prod` stage for the production version. You should change the `siteDomain` and `assetsDomain` to the domain names that you would like to use for each stage. There is also a special stage `local` that is used for the locally run development server.


## Running locally

To run the app locally, start the local HTTP server and the build watch process:

```bash
broil serve
```

Then navigate your browser to the website address as defined in your `local` stage configuration, which is http://localhost:1111/ by default!

The web page is automatically reloaded when the app is re-built.


## Deployment

### Prerequisities

#### Set up AWS credentials

First, create a user and an access key from [AWS Identity and Access Management Console](https://console.aws.amazon.com/iam).

Then you need to set up your AWS credentials to your development machine.
This can be done with [`aws-cli` command line tool](https://github.com/aws/aws-cli), which you may need to [install first](http://docs.aws.amazon.com/cli/latest/userguide/installing.html):

```bash
# Install if not already installed
pip install awscli
# Optional: enable command line completion
complete -C aws_completer aws
# Configure your credentials
aws configure
```

### Running deployment

Deployments are run with the following command:

```bash
broil deploy <stage>
```

For example, to deploy the development version to the `dev` stage:

```bash
broil deploy dev
```

To deploy the production version to the `prod` stage:

```bash
broil deploy prod
```

**IMPORTANT:** When deploying for the first time, you will receive email for confirming the certificate for the domain names!
The deployment continues only after you approve the certificate!

The deployment will build your app files, and then upload them to Amazon S3 buckets. It will also use [CloudFormation](https://aws.amazon.com/cloudformation/) to set up all the required backend, Lambda functions, and SimpleDB database tables.

The assets (JavaScript, CSS, images) are uploaded with their names containing hashes, so they won't conflict with existing files.
They will be cached infinitely with HTTP headers for maximum performance.
The uploaded HTML files are cached for a shorter time.

## Tips

Pro-tip: Use [`npm-check-updates`](https://github.com/tjunnone/npm-check-updates) command line utility to upgrade the npm packages.
