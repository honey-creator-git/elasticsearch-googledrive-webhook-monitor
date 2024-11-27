const { google } = require("googleapis");
const client = require("./elasticsearch");

async function refreshAccessToken(client_id, client_secret, refreshToken) {
    try {
        const auth = new google.auth.OAuth2(client_id, client_secret);

        auth.setCredentials({ refresh_token: refreshToken });

        const { credentials } = await auth.refreshAccessToken();

        return {
            access_token: credentials.access_token,
        };
    } catch (error) {
        console.error("Error refreshing access token:", error.message);
        throw new Error("Failed to refresh access token");
    }
}

async function registerWebhook(drive, gc_accessToken, gc_refreshToken, webhookUrl, datasourceId) {

    // Validate required inputs
    if (!gc_accessToken || !gc_refreshToken || !webhookUrl || !datasourceId) {
        return res.status(400).json({
            error:
                "Missing required fields: gc_accessToken, gc_refreshToken, webhookUrl, datasourceId",
        });
    }

    try {
        // Retrieve the startPageToken to track future changes
        const startTokenResponse = await drive.changes.getStartPageToken();
        const startPageToken = startTokenResponse.data.startPageToken;

        // Register the webhook with Google Drive
        const watchResponse = await drive.files.watch({
            fileId: "root", // Watch the entire Drive
            requestBody: {
                id: `webhook-${Date.now()}`, // Unique channel ID
                type: "web_hook",
                address: webhookUrl, // Your webhook URL
            },
        });

        console.log("Webhook registered successfully:", watchResponse.data);

        // Save webhook details to Elasticsearch or your database
        const resourceId = watchResponse.data.resourceId;
        const expiration = parseInt(watchResponse.data.expiration, 10);

        return {
            resourceId: resourceId,
            expiration: expiration,
            startPageToken: startPageToken,
        };
    } catch (error) {
        console.error("Failed to register webhook:", error.message);

        return {
            error: "Failed to register webhook",
            details: error.message,
        };
    }
};

exports.monitorWebhooks = async () => {
    try {
        console.log("Running webhook monitor...");

        // Step 1: Get all indices with the prefix "resource_category_"
        const indicesResponse = await client.cat.indices({ format: "json" });
        const indices = indicesResponse.map((index) => index.index).filter((name) => name.startsWith("resource_category_"));

        console.log("Found indices : ", indices);

        // Step 2: Iterate over matching indices and query expring webhooks
        const currentTime = Date.now();
        const timeThreshold = currentTime + 5 * 60 * 1000; // 5 minutes before expiration

        for (const index of indices) {
            console.log(`Checking index: ${index}`);

            // Query ElasticSearch for expiring webhooks
            const query = {
                query: {
                    range: {
                        webhookExpiry: {
                            lt: timeThreshold, // Expiring in the next 5 minutes
                        }
                    }
                }
            };

            const result = await client.search({
                index: index,
                body: query
            });

            // Step 3: Re-register each expiring webhook
            for (const webhook of result.hits.hits) {
                const {
                    resourceId,
                    categoryId,
                    coid,
                    gc_accessToken,
                    refreshToken,
                    webhookExpiry,
                    webhookUrl,
                    startPageToken,
                    client_id,
                    client_secret
                } = webhook._source;

                console.log(`Re-registering webhook for resourceId: ${resourceId}`);

                try {
                    const auth = new google.auth.OAuth2();
                    auth.setCredentials({ access_token: gc_accessToken });
                    await auth.getAccessToken(); // Validate token
                    const drive = google.drive({ version: "v3", auth });
                    const newwebhookdetails = await registerWebhook(drive, gc_accessToken, refreshToken, webhookUrl, categoryId)

                    if (!!newwebhookdetails.error) {
                        console.error("Access token expired. Refreshing token...");
                        const refreshedToken = await refreshAccessToken(client_id, client_secret, refreshToken);

                        accessToken = refreshedToken.access_token;
                        auth.setCredentials({ access_token: accessToken });
                        const drive = google.drive({ version: "v3", auth });
                        const newwebhookdetails = await registerWebhook(drive, accessToken, refreshToken, webhookUrl, categoryId)

                        // Step 4: Update the Elasticsearch document with the new expiration time
                        await client.update({
                            index,
                            id: webhook._id,
                            body: {
                                doc: {
                                    webhookExpiry: newwebhookdetails.expiration,
                                    startPageToken: newwebhookdetails.startPageToken,
                                }
                            }
                        });
                    } else {
                        // Step 4: Update the Elasticsearch document with the new expiration time
                        await client.update({
                            index,
                            id: webhook._id,
                            body: {
                                doc: {
                                    webhookExpiry: newwebhookdetails.expiration,
                                    startPageToken: newwebhookdetails.startPageToken,
                                }
                            }
                        });
                    }

                    console.log(`Webhook re-registered for resourceId: ${resourceId}`);
                } catch (tokenError) {
                    console.error("Access token expired. Refreshing token...");
                    const refreshedToken = await refreshAccessToken(client_id, client_secret, refreshToken);
                    accessToken = refreshedToken.access_token;
                    auth.setCredentials({ access_token: accessToken });
                    const drive = google.drive({ version: "v3", auth });
                    const newwebhookdetails = await registerWebhook(drive, accessToken, refreshToken, webhookUrl, categoryId)

                    // Step 4: Update the Elasticsearch document with the new expiration time
                    await client.update({
                        index,
                        id: webhook._id,
                        body: {
                            doc: {
                                webhookExpiry: newwebhookdetails.expiration,
                                startPageToken: newwebhookdetails.startPageToken,
                            }
                        }
                    });

                    console.log(`Webhook re-registered for resourceId: ${resourceId}`);
                }
            }
        }
    } catch (error) {
        console.error("Error in webhook monitor:", error.message);
    }
}