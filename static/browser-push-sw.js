// fallow-ignore-file unused-file
self.addEventListener("push", (event) => {
	const payload = event.data ? event.data.json() : {};
	const title = payload.title || "AlfyAI";
	event.waitUntil(
		self.registration.showNotification(title, {
			body: payload.body || "",
			tag: payload.tag || "alfyai",
			data: { url: payload.url || "/" },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const targetUrl = event.notification.data?.url || "/";
	event.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((clients) => {
				for (const client of clients) {
					if ("focus" in client) {
						client.navigate(targetUrl);
						return client.focus();
					}
				}
				return self.clients.openWindow(targetUrl);
			}),
	);
});
