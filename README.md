# neptune-gremlin

The `neptune-gremlin` package is an SDK for querying an Amazon Neptune graph
database using gremlin. Amazon Neptune is is a fast, reliable, fully managed
graph database service that makes it easy to build and run applications. It
allows you to build connections between identities, build knowledge graphs,
detect fraud patterns, and make predictions. It can also simply be used as a
general purpose database, which is made easier by this package.

The source for this package includes an AWS CDK application that creates a Neptune 
cluster and a Lambda function in the same VPC to facilitate integration testing.

*NOTICE* _This is an experimental package that is not supported in any way by AWS. 
Please do not use it for mission critical production workloads!_

## Installation

```sh
npm install neptune-gremlin
```

## Usage

### Connect to Neptune:

```Javascript
const gremlin = require("neptune-gremlin")

// Get configuration values from the environment
const host = process.env.NEPTUNE_ENDPOINT
const port = process.env.NEPTUNE_PORT
const useIam = process.env.USE_IAM === "true"

// Create a new connection to the Neptune database
const connection = new gremlin.Connection(host, port, useIam)
await connection.connect()
```

### Save a node (vertex):

```Javascript
const node1 = {
    "unique-id-1",
    properties: {
        name: "Test Node",
        a: "A",
        b: "B",
    },
    labels: ["label1", "label2"],
}
await connection.saveNode(node1)
```

### Run a custom traversal:

```Javascript
const f = (g) => {
    return await g.V()
        .has("person", "name", "Eric")
        .bothE().bothV().dedup()
        .valueMap(true).toList()
}
const result = await connection.query(f)
```

## Development

### Building the project

This package is all Javascript, so the build script just runs eslint, copies `neptune-gremlin.js`
into the cdk app's lambda folder, and then synthesizes the cdk app.

```sh
npm run build
```

### Making changes

If you want to make a change or an addition to the package (contributions welcome!), please 
add a test to `cdk-test-app/lambda/integration-test.js`. Deploy the stack to your AWS account 
and invoke the function to make sure everything works as expected.

### Deploying the cdk test app

Make sure you run the top level build script, since it copies the latest `neptune-gremlin.js` 
file into the cdk app's lambda folder.

Also keep in mind that the very first call to a new Neptune cluster tends to fail with a 500, 
so if that happens, just try again.

```sh
npm run build
cd cdk-test-app
npm install
cd lambda
npm install
cd ..
npx cdk bootstrap
npx cdk synth
npx cdk diff
npx cdk deploy
```
