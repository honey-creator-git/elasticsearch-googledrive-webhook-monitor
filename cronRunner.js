const cron = require("node-cron");
const monitorWebhooks = require("./monitorWebhooks").monitorWebhooks;

// Run every 5 minutes
cron.schedule("*/5 * * * *", async () => {
    console.log("Executing webhook monitor job...");
    await monitorWebhooks();
});

console.log("Webhook monitor is running...");
