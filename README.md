# BroilerKit

**BroilerKit** is a framework for quickly developing web apps with modern technologies and deploying them to a scalable, production-ready environment! You can write both frontend and backend in [TypeScript](http://www.typescriptlang.org/) (powered by [Webpack](https://webpack.js.org/)). You write your front-end with [React framework](https://reactjs.org), and server-side rendering (SSR) is supported by default!

You deploy your production-ready web app to [Amazon Web Services cloud platform](https://aws.amazon.com/), with minimal setup and very low costs! The hosting is almost free (but not free) on low-traffic sites.

(**Disclaimer:** By using this utility you are taking the full responsibility for any incurring expenses.)

### Feature highlights

- Write all your code, both front-end and backend, in [TypeScript](http://www.typescriptlang.org/)
- Easily create a full-featured REST API as your backend and database models
- Your React-based front-end is rendered on server-side by default
- Easily add the user log in to your app with **Facebook and Google authentication**
- Write your stylesheets in [SASS](http://sass-lang.com/)
- No server maintenance: everything will run on [AWS platform](https://aws.amazon.com/) serverless solutions

### Other features

- Lint your JavaScript code style with [ESLint](http://eslint.org/)
- Lint your TypeScript code style with [TSLint](https://palantir.github.io/tslint/)
- Polyfill `Promise`, `Symbol` and other ES6 features for browsers that do not support them
- Automatically bundle any images from your HTML, Pug, or Markdown files.
- Automatically **optimize images losslessly** for minimal size
- Generate favicons and related asset files from a single icon image file, and insert references to the HTML pages
- Refer to your current GIT version with `__COMMIT_HASH__`, `__VERSION__` and `__BRANCH__` constants

### Deployment features

- Host your backend on serverless [AWS Lambda functions](https://aws.amazon.com/lambda/) through [AWS API Gateway](https://aws.amazon.com/api-gateway/)
- Deploy your compressed, production-ready React front-end to [AWS platform](https://aws.amazon.com/), hosted on [S3](https://aws.amazon.com/s3/), served globally through [CloudFront](https://aws.amazon.com/cloudfront/), and managed with [CloudFormation](https://aws.amazon.com/cloudformation/)
- Server-side rendering of the React front-end
- Make your app available on your **custom domain** (_required_)
- Your app is served using **HTTPS**! Creation of required certificates are done automatically with [Amazon Certificate Manager](https://aws.amazon.com/certificate-manager/)
- Host static assets on separate cookieless domain with infinite caching, for maximum performance scoring and reliability
- Separate **stages** for your releases, e.g. the production version (`prod`) and the development version (`dev`)

## What do I need?

To use this utility, you need the following:

- Your own **domain** for your web app. You can buy one, e.g, from [GoDaddy](https://www.godaddy.com/domains).
- An [Amazon Web Services](https://aws.amazon.com/) account. You can get started with [AWS Free Tier](https://aws.amazon.com/free/).

## Command line tools

The BroilerKit contains a lot of command line utilities to initialize, deploy, manage and inspect your app!
You can run these commands with `npx`. You can print out the help for the available commands:

```
$ npx broilerkit --help
broilerkit <command>

Commands:
  broilerkit init [directory]      Bootstrap your app with Broilerplate template.    [aliases: pull]
  broilerkit deploy <stage>        Deploy the web app for the given stage.
  broilerkit undeploy <stage>      Deletes the previously deployed web app.
  broilerkit logs <stage> [since]  Print app logs.
  broilerkit compile <stage>       Compile the web app.                             [aliases: build]
  broilerkit preview <stage>       Preview the changes that would be deployed.
  broilerkit describe <stage>      Describes the deployed resources.
  broilerkit serve [stage]         Run the local development server.
  broilerkit db <command>          Manage database tables

Options:
  --appConfigPath  Path to the app configuration                        [string] [default: "app.ts"]
  --debug          Compile assets for debugging                                            [boolean]
  --no-color       Print output without colors                                             [boolean]
  --help           Show help                                                               [boolean]
  --version        Show version number                                                     [boolean]
```

## Creating a web app

To start developing a new web app, first create a GIT repository for it:

```bash
git init myapp
cd myapp
```

Then it is recommended that you apply the [Broilerplate template](https://github.com/ktkiiski/broilerplate.git) to your project:

```
npx broilerkit init
```

If installing fails on OSX [you may try to install libpng with Homebrew](https://github.com/tcoopman/image-webpack-loader#libpng-issues).


## Configuring the app

Remember to add your project metadata to the `package.json`, for example, `name`, `author`, `description`.

You should change the configuration in `app.ts` according to your web app's needs.

- `name`: A distinct name of your app. Recommended to be in lower case and separate words with dashes, because the name will be used in Amazon resource names and internal host names.
- `stages`: Configuration for each different stage that your app has. By default there are `dev` stage for a development version and `prod` stage for the production version. You should change the `serverRoot` and `assetsRoot` to the domain names that you would like to use for each stage. There is also a special stage `local` that is used for the locally run development server.


## Running locally

To run the app locally, start the local HTTP server and the build watch process:

```bash
npx broilerkit serve
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
npx broilerkit deploy <stage>
```

For example, to deploy the development version to the `dev` stage:

```bash
npx broilerkit deploy dev
```

To deploy the production version to the `prod` stage:

```bash
npx broilerkit deploy prod
```

The deployment will build your app files, and then upload them to Amazon S3 buckets. It will also use [CloudFormation](https://aws.amazon.com/cloudformation/) to set up all the required backend, Lambda functions, databases, SSL certificates, etc.

The assets (JavaScript, CSS, images) are uploaded with their names containing hashes, so they won't conflict with existing files.
They will be cached infinitely with HTTP headers for maximum performance.
The uploaded HTML files are cached for a shorter time.
