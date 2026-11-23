function runHandler(url) {
	var [_, extension] = url.match(/^zotero:\/\/([a-z]+)\//);
	var handler = Services.io.getProtocolHandler('zotero').wrappedJSObject;
	var uri = Services.io.newURI(url, null, null);
	return handler._extensions['zotero://' + extension].newChannel(uri);
}

describe("Protocol Handler", function () {
	var win;
	var zp;
	
	before(async function () {
		win = await loadZoteroPane();
		zp = win.ZoteroPane;
	});
	
	after(function () {
		win.close();
	});
	
	describe("zotero://select", function () {
		async function waitForItemSelect(items) {
			if (items instanceof Zotero.Item) {
				items = [items];
			}
			while (true) {
				let selected = zp.getSelectedItems();
				if (selected.every(item => items.includes(item))) {
					return;
				}
				await Zotero.Promise.delay(20);
			}
		}
		
		it("should select an item", async function () {
			var item1 = await createDataObject('item', { title: 'A' });
			var item2 = await createDataObject('item', { title: 'B' });
			runHandler(`zotero://select/library/items/${item1.key}`);
			await waitForItemSelect(item1);
		});
		
		it("should select multiple items", async function () {
			var item1 = await createDataObject('item', { title: 'A' });
			var item2 = await createDataObject('item', { title: 'B' });
			var item3 = await createDataObject('item', { title: 'C' });
			runHandler(`zotero://select/library/items?itemKey=${item1.key},${item2.key}`);
			await waitForItemSelect([item1, item2]);
		});
	});

	describe("zotero://open", function () {
		// Where the file is opened
		async function openAt(url) {
			let open = sinon.stub(Zotero.FileHandlers, 'open').resolves();
			try {
				runHandler(url);
				while (!open.called) {
					await Zotero.Promise.delay(20);
				}
				return open.firstCall.args[1].location;
			}
			finally {
				open.restore();
			}
		}

		it("should open a PDF at a page, or at a rectangle on it", async function () {
			let attachment = await importFileAttachment('test.pdf');
			let url = `zotero://open/library/items/${attachment.key}`;
			assert.deepEqual(await openAt(`${url}?page=2`), { pageIndex: 1 });
			assert.deepEqual(await openAt(`${url}?page=2&rect=10,20.5,300,40`), {
				pageIndex: 1,
				position: { pageIndex: 1, rects: [[10, 20.5, 300, 40]] },
			});
			// Not a rectangle
			assert.deepEqual(await openAt(`${url}?page=2&rect=10,20`), { pageIndex: 1 });
		});

		it("should open a snapshot at an element, or at a range of its text", async function () {
			let attachment = await importSnapshotAttachment(await createDataObject('item'));
			let url = `zotero://open/library/items/${attachment.key}?sel=${encodeURIComponent('body > p')}`;
			assert.deepEqual(await openAt(url), { position: { type: 'CssSelector', value: 'body > p' } });
			assert.deepEqual(await openAt(`${url}&start=3&end=9`), {
				position: {
					type: 'CssSelector',
					value: 'body > p',
					refinedBy: { type: 'TextPositionSelector', start: 3, end: 9 },
				},
			});
			// A range of all of its text
			url = `zotero://open/library/items/${attachment.key}`;
			assert.deepEqual(await openAt(`${url}?start=120&end=140`), {
				position: { type: 'TextPositionSelector', start: 120, end: 140 },
			});
			// Not a range
			assert.isNull(await openAt(`${url}?start=140&end=x`));
		});
	});
});