/*
 * Frontend API client for the NFN Academy app.
 *
 * Implements the same Firestore-like interface the app already uses:
 *   db.collection(col).onSnapshot(cb, errCb)
 *   db.collection(col).doc(id).set(obj)
 *   db.collection(col).doc(id).delete()
 *   db.doc(path).onSnapshot(cb, errCb)
 *   db.doc(path).set(obj)
 *   db.doc(path).delete()
 *
 * The snapshot objects match what the app expects:
 *   collection snapshot: { docs: [{ id, data: () => obj }, ...] }
 *   doc snapshot: { exists: boolean, data: () => obj }
 *
 * Real-time updates are delivered via a single SSE connection; the server
 * broadcasts every change and this client dispatches to the right callbacks.
 * Loaded on the page before the app's IIFE; exposes window.ApiDB.
 */
(function () {
  function ApiDB(baseUrl) {
    this.baseUrl = baseUrl || "";
    this._colCbs = new Map();   // collection -> Set<callback>
    this._docCbs = new Map();    // "col/id" -> Set<callback>
    this._cache = {};            // collection -> { id: data }
    this._sse = null;
    this._connectSSE();
  }

  ApiDB.prototype._connectSSE = function () {
    var self = this;
    try {
      this._sse = new EventSource(this.baseUrl + "/api/events");
    } catch (e) {
      /* SSE not available — initial fetches still work, just no live updates */
      return;
    }
    this._sse.addEventListener("change", function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      var col = msg.collection, id = msg.id, data = msg.data;
      if (!self._cache[col]) self._cache[col] = {};
      if (data === null) delete self._cache[col][id];
      else self._cache[col][id] = data;
      self._notifyCollection(col);
      self._notifyDoc(col, id);
    });
    this._sse.addEventListener("error", function () {
      /* EventSource auto-reconnects; nothing to do here */
    });
  };

  ApiDB.prototype._colSnapshot = function (col) {
    var map = this._cache[col] || {};
    var docs = Object.keys(map).map(function (id) {
      return { id: id, data: function () { return map[id]; } };
    });
    return { docs: docs };
  };

  ApiDB.prototype._docSnapshot = function (col, id) {
    var data = this._cache[col] && this._cache[col][id];
    return { exists: data !== undefined, data: function () { return data || {}; } };
  };

  ApiDB.prototype._notifyCollection = function (col) {
    var set = this._colCbs.get(col);
    if (set) set.forEach(function (cb) { cb(this._colSnapshot(col)); }, this);
  };

  ApiDB.prototype._notifyDoc = function (col, id) {
    var key = col + "/" + id;
    var set = this._docCbs.get(key);
    if (set) set.forEach(function (cb) { cb(this._docSnapshot(col, id)); }, this);
  };

  ApiDB.prototype.collection = function (col) {
    var self = this;
    return {
      onSnapshot: function (cb, errCb) {
        if (!self._colCbs.has(col)) self._colCbs.set(col, new Set());
        self._colCbs.get(col).add(cb);
        fetch(self.baseUrl + "/api/c/" + encodeURIComponent(col))
          .then(function (r) { return r.json(); })
          .then(function (docs) {
            if (!self._cache[col]) self._cache[col] = {};
            for (var i = 0; i < docs.length; i++) {
              self._cache[col][docs[i].id] = docs[i].data;
            }
            cb(self._colSnapshot(col));
          })
          .catch(function (err) { if (errCb) errCb(err); });
      },
      doc: function (id) {
        return self._docRef(col, id);
      }
    };
  };

  ApiDB.prototype.doc = function (path) {
    var idx = path.indexOf("/");
    var col = idx === -1 ? path : path.slice(0, idx);
    var id = idx === -1 ? "" : path.slice(idx + 1);
    return this._docRef(col, id);
  };

  ApiDB.prototype._docRef = function (col, id) {
    var self = this;
    var url = self.baseUrl + "/api/c/" + encodeURIComponent(col) + "/" + encodeURIComponent(id);
    return {
      set: function (obj) {
        return fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(obj)
        }).then(function () { return undefined; });
      },
      delete: function () {
        return fetch(url, { method: "DELETE" }).then(function () { return undefined; });
      },
      onSnapshot: function (cb, errCb) {
        var key = col + "/" + id;
        if (!self._docCbs.has(key)) self._docCbs.set(key, new Set());
        self._docCbs.get(key).add(cb);
        fetch(url)
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!self._cache[col]) self._cache[col] = {};
            if (data === null) delete self._cache[col][id];
            else self._cache[col][id] = data;
            cb(self._docSnapshot(col, id));
          })
          .catch(function (err) { if (errCb) errCb(err); });
      }
    };
  };

  window.ApiDB = ApiDB;
})();
