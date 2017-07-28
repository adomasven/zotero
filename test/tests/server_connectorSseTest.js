describe('Connector Server Server-Sent Events', function() {
	describe('/connector/sse', function() {
		var writeCallback = sinon.stub();
		
		before(function* () {
			yield loadZoteroPane();
		});
		
		it('should add a listener to listener list upon connection', function() {
			Zotero.Server.SSE.Endpoints['/connector/sse'](writeCallback);
			assert.equal(Zotero.Server.SSE.Connector._listeners.length, 1);
		});
		
		it('should call the writeCallback on Zotero.Server.SSE.Connector.sendEvent()', function() {
			Zotero.Server.SSE.Connector.notify('test', 'testData');
			assert.equal(writeCallback.callCount, 1);
			assert.equal(writeCallback.lastCall.args[0], `data: ${JSON.stringify({data:'testData', event: 'test'})}\n\n`);
		});
		
		it('should remove the listener when writeCallback throws an error', function() {
			writeCallback.throws(new Error('Client disconnected'));
			Zotero.Server.SSE.Connector.notify('test', 'testData');
			assert.equal(Zotero.Server.SSE.Connector._listeners.length, 0);
		});
	});
});
