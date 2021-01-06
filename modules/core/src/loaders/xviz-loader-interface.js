// Copyright (c) 2019 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import {getXVIZConfig, StreamSynchronizer, LOG_STREAM_MESSAGE} from '@xviz/parser';
import {clamp} from 'math.gl';

import PlayableLoaderInterface from './playable-loader-interface';
import createSelector from '../utils/create-selector';
import stats from '../utils/stats';

/* eslint-disable callback-return */
export default class XVIZLoaderInterface extends PlayableLoaderInterface {
  constructor(options = {}) {
    super();
    this.options = options;
    this._debug = options.debug || (() => {});
    this.callbacks = {};
  }

  /* Event types:
   * - ready
   * - update
   * - finish
   * - error
   */
  on(eventType, cb) {
    this.callbacks[eventType] = this.callbacks[eventType] || [];
    this.callbacks[eventType].push(cb);
    return this;
  }

  off(eventType, cb) {
    const callbacks = this.callbacks[eventType];
    if (callbacks) {
      const index = callbacks.indexOf(cb);
      if (index >= 0) {
        callbacks.splice(index, 1);
      }
    }
    return this;
  }

  emit(eventType, eventArgs) {
    const callbacks = this.callbacks[eventType];
    if (callbacks) {
      for (const cb of callbacks) {
        cb(eventType, eventArgs);
      }
    }
    stats.get(`loader-${eventType}`).incrementCount();
  }

  onXVIZMessage = message => {
    switch (message.type) {
      case LOG_STREAM_MESSAGE.METADATA:
        this._onXVIZMetadata(message);
        this.emit('ready', message);
        break;

      case LOG_STREAM_MESSAGE.TIMESLICE:
        this._onXVIZTimeslice(message);
        this.emit('update', message);
        break;

      case LOG_STREAM_MESSAGE.DONE:
        this.emit('finish', message);
        break;

      default:
        this.emit('error', message);
    }
  };

  onError = error => {
    this.emit('error', error);
  };

  seek(timestamp) {
    const metadata = this.getMetadata();

    if (metadata) {
      const startTime = this.getLogStartTime();
      const endTime = this.getLogEndTime();
      if (Number.isFinite(startTime) && Number.isFinite(endTime)) {
        timestamp = clamp(timestamp, startTime, endTime);
      }
    }

    this.set('timestamp', timestamp);

    // Notify the stream buffer of the current play head
    // for any data management needs.
    this.streamBuffer.setCurrentTime(timestamp);
  }

  updateStreamSettings(settings) {
    const streamSettings = this.get('streamSettings');
    this.set('streamSettings', {...streamSettings, ...settings});
  }

  /* Data selector API */

  getMetadata = () => this.get('metadata');

  getStreamSettings = () => this.get('streamSettings');

  _getStreamsMetadata = () => this.get('streamsMetadata');

  _getStreams = createSelector(this, this._getDataVersion, () => this._getDataByStream());

  getBufferedTimeRanges = createSelector(this, this._getDataVersion, () =>
    this._getBufferedTimeRanges()
  );

  getStreams = createSelector(
    this,
    [this.getStreamSettings, this._getStreams, this._getDataVersion],
    (streamSettings, streams) => {
      if (!streamSettings || !streams) {
        return streams;
      }
      const result = {};
      for (const streamName in streams) {
        if (streamSettings[streamName]) {
          result[streamName] = streams[streamName];
        }
      }
      return result;
    }
  );

  getStreamsMetadata = getXVIZConfig().DYNAMIC_STREAM_METADATA
    ? createSelector(
        this,
        [this.getMetadata, this._getStreamsMetadata],
        (metadata, streamsMetadata) => {
          return Object.assign({}, streamsMetadata, metadata && metadata.streams);
        }
      )
    : createSelector(this, this.getMetadata, metadata => (metadata && metadata.streams) || {});

  getBufferStartTime = createSelector(this, this.getCurrentTime, () => this._getBufferStartTime());
  getBufferEndTime = createSelector(this, this.getCurrentTime, () => this._getBufferEndTime());

  getLogStartTime = createSelector(this, this.getMetadata, metadata =>
    this._getLogStartTime(metadata)
  );
  getLogEndTime = createSelector(this, this.getMetadata, metadata => this._getLogEndTime(metadata));

  getCurrentFrame = createSelector(
    this,
    [this.getStreamSettings, this.getCurrentTime, this.getLookAhead, this._getDataVersion],
    // `dataVersion` is only needed to trigger recomputation.
    // The logSynchronizer has access to the timeslices.
    (streamSettings, timestamp, lookAhead) => {
      const {logSynchronizer} = this;
      if (logSynchronizer && Number.isFinite(timestamp)) {
        logSynchronizer.setTime(timestamp);
        logSynchronizer.setLookAheadTimeOffset(lookAhead);
        return logSynchronizer.getCurrentFrame(streamSettings);
      }
      return null;
    }
  );

  /* Subclass hooks */

  _onXVIZMetadata(metadata) {
    this.set('metadata', metadata);
    if (metadata.streams && Object.keys(metadata.streams).length > 0) {
      this.set('streamSettings', metadata.streams);
    }

    if (!this.streamBuffer) {
      throw new Error('streamBuffer is missing');
    }
    this.logSynchronizer = this.logSynchronizer || new StreamSynchronizer(this.streamBuffer);

    const timestamp = this.get('timestamp');
    const newTimestamp = Number.isFinite(timestamp) ? timestamp : metadata.start_time;
    if (Number.isFinite(newTimestamp)) {
      this.seek(newTimestamp);
    }
  }

  /* eslint-disable complexity */
  _onXVIZTimeslice(timeslice) {
    const oldStreamCount = this.streamBuffer.streamCount;
    const bufferUpdated = this.streamBuffer.insert(timeslice);
    if (bufferUpdated) {
      this._bumpDataVersion();
    }

    if (getXVIZConfig().DYNAMIC_STREAM_METADATA && this.streamBuffer.streamCount > oldStreamCount) {
      const streamsMetadata = {};
      const streamSettings = this.get('streamSettings') || {};

      for (const streamName in timeslice.streams) {
        const haveStreamMetadata = Boolean(streamsMetadata[streamName]);
        if (timeslice.streams[streamName] && !haveStreamMetadata) {
          streamsMetadata[streamName] = timeslice.streams[streamName].__metadata;
        }

        // Add new stream name to stream settings (default on)
        if (!(streamName in streamSettings)) {
          streamSettings[streamName] = true;
        }
      }

      // Had to add this to get poses to show up and not be filtered out
      for (const streamName in timeslice.poses) {
        const haveStreamMetadata = Boolean(streamsMetadata[streamName]);
        if (timeslice.poses[streamName] && !haveStreamMetadata) {
          streamsMetadata[streamName] = timeslice.poses[streamName].__metadata;
        }

        // Add new stream name to stream settings (default on)
        if (!(streamName in streamSettings)) {
          streamSettings[streamName] = true;
        }
      }

      this.set('streamsMetadata', streamsMetadata);
      this.set('streamSettings', {...streamSettings});
    }

    return bufferUpdated;
  }
  /* eslint-enable complexity */

  _getDataByStream() {
    // XVIZStreamBuffer.getStreams filters out missing streams. This has significant impact
    // on performance. Here we take the unfiltered slices and only filter them if a stream
    // is used.

    // return this.streamBuffer.getStreams();
    return this.streamBuffer.streams;
  }

  _getBufferedTimeRanges() {
    const range = this.streamBuffer.getLoadedTimeRange();
    if (range) {
      return [[range.start, range.end]];
    }
    return [];
  }

  _getLogStartTime(metadata) {
    return metadata && metadata.start_time && metadata.start_time + getXVIZConfig().TIME_WINDOW;
  }

  _getLogEndTime(metadata) {
    return metadata && metadata.end_time;
  }

  _getBufferStartTime() {
    return this.getLogStartTime();
  }

  _getBufferEndTime() {
    return this.getLogEndTime();
  }
}
