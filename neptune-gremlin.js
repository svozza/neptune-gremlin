const gremlin = require("gremlin")
const async = require("async")
const {traversal} = gremlin.process.AnonymousTraversalSource
const {DriverRemoteConnection} = gremlin.driver
const util = require("util")
const aws4 = require("aws4")

/**
 * Represents a connection to Neptune's gremlin endpoint.
 * 
 * TODO: Publish this to its own repo and NPM once it's stable.
 * TODO: Get a single node, get a single edge
 * TODO: A-B-C queries. node label/props - edge label/props - node label/props
 *       e.g. person/title=Manager - manages - person/title=Engineer
 *            person/name=Eric - owns/leased=true - car/color=Blue
 * 
 * Connect to Neptune:
 * 
 * ```Javascript
 * const gremlin = require("./aws-neptune-gremlin")
 * 
 * // Get configuration values from the environment
 * const host = process.env.NEPTUNE_ENDPOINT
 * const port = process.env.NEPTUNE_PORT
 * const useIam = process.env.USE_IAM === "true"
 * 
 * // Create a new connection to the Neptune database
 * const connection = new gremlin.Connection(host, port, useIam)
 * await connection.connect()
 * ```
 * 
 * Save a node (vertex):
 * 
 * ```Javascript
 * const node1 = {
 *     "unique-id-1",
 *     properties: {
 *         name: "Test Node",
 *         a: "A",
 *         b: "B",
 *     },
 *     labels: ["label1", "label2"],
 * }
 * await connection.saveNode(node1)
 * ```
 * 
 * Run a custom traversal:
 * 
 * ```Javascript
 * const f = (g) => {
 *     return await g.V()
 *         .has("person", "name", "Eric")
 *         .bothE().bothV().dedup()
 *         .valueMap(true).toList()
 * }
 * const result = await connection.query(f)
 * ```
 * 
 * @see https://docs.aws.amazon.com/neptune/latest/userguide/lambda-functions-examples.html
 */
class Connection {

    /**
     * Initialize the connection instance.
     * 
     * @param {String} host 
     * @param {number} port 
     * @param {boolean} useIam 
     */
    constructor(host, port, useIam) {
        this.host = host
        this.port = port
        this.useIam = useIam
        this.connection = null
    }

    /**
     * Connect to the endpoint.
     */
    async connect() {

        const path = "/gremlin"

        const url = `wss://${this.host}:${this.port}${path}`
        const headers = this.useIam ? getHeaders(this.host, this.port, {}, path) : {}

        console.info("url: ", url)
        console.info("headers: ", headers)

        this.connection = new DriverRemoteConnection(
            url,
            {
                mimeType: "application/vnd.gremlin-v2.0+json",
                headers,
            })

        this.connection._client._connection.on("close", (code, message) => {
            console.info(`close - ${code} ${message}`)
            if (code == 1006) {
                console.error("Connection closed prematurely")
                throw new Error("Connection closed prematurely")
            }
        })

    }

    /**
     * Query the endpoint.
     * 
     * For simple use cases, use the provided helper functions `saveNode`, `saveEdge`, etc.
     * 
     * @param {Function} f - Your query function with signature f(g), where `g` is
     * the gremlin traversal source.
     */
    async query(f) {

        console.log("About to get traversal")
        let g = traversal().withRemote(this.connection)

        console.log("About to start async retry loop")
        return async.retry(
            {
                times: 5,
                interval: 1000,
                errorFilter: function (err) {

                    // Add filters here to determine whether error can be retried
                    console.warn("Determining whether retriable error: " + err.message)

                    // Check for connection issues
                    if (err.message.startsWith("WebSocket is not open")) {
                        console.warn("Reopening connection")
                        this.connection.close()
                        this.connect()
                        g = traversal().withRemote(this.connection)
                        return true
                    }

                    // Check for ConcurrentModificationException
                    if (err.message.includes("ConcurrentModificationException")) {
                        console.warn("Retrying query because of ConcurrentModificationException")
                        return true
                    }

                    // Check for ReadOnlyViolationException
                    if (err.message.includes("ReadOnlyViolationException")) {
                        console.warn("Retrying query because of ReadOnlyViolationException")
                        return true
                    }

                    return false
                },

            },
            async () => {
                console.log("About to call the query function")
                return await f(g)
            })
    }

    /**
     * Save a node (vertex).
     * 
     * For updates, keep in mind that the label(s) cannot be changed.
     * 
     * Properties will be created/updated/deleted as necessary.
     * 
     * Expected model: { id: "", properties: {}, labels: [] }
     * 
     * @param {*} node 
     */
    async saveNode(node) {
        console.info("saveNode", node)

        await this.query(async function (g) {
            const existing = await g.V(node.id).next()
            console.log(existing)

            if (existing.value) {
                // If it exists already, only update its properties
                console.info("node exists", existing.value)
                await updateProperties(node.id, g, node.properties)
            } else {
                // Create the new node
                const result = await g.addV(node.labels.join("::"))
                    .property(gremlin.process.t.id, node.id)
                    .next()
                console.log(util.inspect(result))
                await updateProperties(node.id, g, node.properties)
            }
        })

    }

    /**
     * Delete a node and its related edges.
     * 
     * @param {*} id 
     */
    async deleteNode(id) {
        console.info("deleteNode", id)

        await this.query(async function (g) {
            await g.V(id).inE().drop().next()
            await g.V(id).outE().drop().next()
            await g.V(id).drop().next()
        })
    }

    /**
     * Save an edge (a relationship between two nodes).
     * 
     * Updates only changed properties, the label and to-from can't be changed.
     * 
     * @param {*} edge 
     */
    async saveEdge(edge) {
        console.info("saveEdge", edge)

        await this.query(async function (g) {

            const existing = await g.E(edge.id).next()
            console.log(existing)

            if (existing.value) {
                // If it exists already, only update its properties
                console.info("Edge exists", existing)
                await updateProperties(edge.id, g, edge.properties, false)
            } else {
                // Create the new edge
                const result = await g.V(edge.to)
                    .as("a")
                    .V(edge.from)
                    .addE(edge.label)
                    .property(gremlin.process.t.id, edge.id)
                    .from_("a")
                    .next()

                console.log(util.inspect(result))

                await updateProperties(edge.id, g, edge.properties, false)
            }

        })
    }

    /**
     * Delete a node and its related edges.
     * 
     * @param {*} id 
     */
    async deleteEdge(id) {
        console.info("deleteEdge", id)

        await this.query(async function (g) {
            await g.E(id).drop().next()
        })
    }

    /**
     * Perform a search that returns nodes and edges.
     * 
     * Sending an empty options object returns all nodes and edges.
     * 
     * Sending `options.focus` will return one node and all of its direct relationships.
     * 
     * (This is a catch-all function for anything that returns the graph or a sub-graph, 
     * it might be better to separate this out into multiple functions)
     * 
     * 
     * @param {*} options 
     * ```json
     * {
     *     focus: {
     *         label: "",
     *         key: "",
     *         value: "", 
     *     }
     * }
     * ```
     * 
     * 
     * @returns {*}
     * ```json
     * { 
     *     nodes: [
     *         { id: "", properties: {}, labels: []}
     *     ], 
     *     edges: [
     *         { id: "", label: "", to: "", from: "", properties: {} }
     *     ]
     * }
     * ```
     * 
     */
    async search(options) {

        // TODO: Create some intuitive options
        //      - Node "A" and its direct edges, plus their edges in common with "A"
        //      - All nodes with label "Person"
        //      - Depth setting to iterate down edges
        //      - A-B-C relationships. People who like movies made by Disney.

        console.info("search", options)

        return await this.query(async function (g) {

            let rawNodes
            if (options.focus) {
                console.info("options.focus", options.focus)
                rawNodes = await g.V()
                    .has(options.focus.label, options.focus.key, options.focus.value)
                    .bothE().bothV().dedup()
                    .valueMap(true).toList()
            } else {
                // Get everything
                rawNodes = await g.V().valueMap(true).toList()
            }
            console.info("rawNodes", rawNodes)

            const rawEdges = await g.E().elementMap().toList()
            console.info("rawEdges", rawEdges)

            const nodes = []
            const edges = []
            for (const n of rawNodes) {
                const node = {
                    id: "",
                    labels: [],
                    properties: {},
                }
                node.id = n.id
                node.labels = n.label
                if (!Array.isArray(node.labels)) {
                    node.labels = [node.labels]
                }
                node.properties = {}
                for (const p in n) {
                    if (p !== "id" && p !== "label") {
                        const val = n[p]
                        if (Array.isArray(val)) {
                            if (val.length == 1) {
                                node.properties[p] = val[0]
                            } else {
                                node.properties[p] = val
                            }
                        } else {
                            node.properties[p] = val
                        }
                    }
                }
                nodes.push(node)
            }
            for (const e of rawEdges) {
                const edge = {
                    id: "",
                    label: "",
                    from: "",
                    to: "",
                    properties: {},
                }
                for (const key in e) {
                    switch (key) {
                        case "id":
                            edge.id = e[key]
                            break
                        case "label":
                            edge.label = e[key]
                            break
                        case "IN":
                            edge.from = e[key].id
                            break
                        case "OUT":
                            edge.to = e[key].id
                            break
                        default:
                            // Everything else is part of properties
                            edge.properties[key] = e[key]
                            break
                    }
                }
                if (nodeExists(nodes, edge.from) && nodeExists(nodes, edge.to)) {
                    edges.push(edge)
                }
            }
            return {
                nodes,
                edges,
            }

        })
    }
}

/**
 * Update the properties of an existing node or edge. NB: any properties contained in the DB version
 * but *not* contained in the props parameter will be deleted.
 *
 * Cardinality is always single for node properties.
 *
 * @param {*} id
 */
async function updateProperties(id, g, props, isNode = true) {

    const gve = isNode ? g.V : g.E

    // Compare existing props and delete any that are missing
    const existingProps = await gve.call(g, id).valueMap().toList()
    console.info("existingProps", existingProps)

    const propsToDrop = Object.keys(existingProps[0]).filter(key => props[key] == null)
    await gve.call(g, id).properties(...propsToDrop).drop().next()

    // We split props into an array of tuples ([['key1', 'val1'], ['key2', 'val2'], ...] and pass it to reduce.
    // We use gve.call(g, id) as the initial value for the reduce. Each time the reducer function receives a
    // key/value pair we chain another call to property() onto the query we've been building and pass the
    // current key and value as arguments to property(). The cardinality.single argument is required to overwrite
    // the old value, otherwise it would just be appended to a list of values
    const updatePropsTraversal = Object.entries(props).reduce((query, [key, value]) => {
        return isNode ? query.property(gremlin.process.cardinality.single, key, value)
            : query.property(key, value)
    }, gve.call(g, id))

    return updatePropsTraversal.next()
}

/**
 * Check to see if the node exists within the array.
 * 
 * @param {*} nodes 
 * @param {*} id 
 * @returns boolean
 */
function nodeExists(nodes, id) {
    for (const node of nodes) {
        if (node.id === id) {
            return true
        }
    }
    console.log(`Node with id ${id} does not exist in search results`)
    return false
}

/**
 * Sigv4 
 * 
 * @param {String} host Database hostname (Neptune cluster Writer endpoint)
 * @param {number} port Database port, typically 8182
 * @param {*} credentials Optional { accessKey, secretKey, sessionToken, region }
 * @param {*} canonicalUri e.g. "/gremlin"
 * @returns {Host, Authorization, X-Amz-Security-Token, X-Amz-Date}
 */
function getHeaders(host, port, credentials, canonicalUri) {

    if (!host || !port) {
        throw new Error("Host and port are required")
    }

    const accessKeyId = credentials.accessKey || credentials.accessKeyId
        || process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = credentials.secretKey || credentials.secretAccessKey
        || process.env.AWS_SECRET_ACCESS_KEY
    const sessionToken = credentials.sessionToken || process.env.AWS_SESSION_TOKEN
    const region = credentials.region || process.env.AWS_DEFAULT_REGION

    if (!accessKeyId || !secretAccessKey) {
        throw new Error("Access key and secret key are required")
    }

    const signOptions = {
        host: `${host}:${port}`,
        region,
        path: canonicalUri,
        service: "neptune-db",
    }

    return aws4.sign(signOptions, { accessKeyId, secretAccessKey, sessionToken }).headers
}

module.exports = { Connection, updateProperties, getHeaders }