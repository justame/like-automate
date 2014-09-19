var phantom = require('phantom');
var fs = require('fs');
var http = require('http');
var querystring = require('querystring');
var restler = require('restler');
var _ = require('underscore');
var handlebars = require('handlebars');
var Q = require('q');
var util = require('util');


function Snapshotter(targetUrl, webhook) {
  var _that = this;
  var _phantomInstance = null;
  var _phantomPageInstance = null;
  var _snapshotSent = false;
  var _htmlSent = false;
  var _error = false;
  var _pageMargin = 40;
  var _pageWidth = 700;
  var _webhook = webhook;
  
  var _config = {};
  _config.emailTemplateFile = 'emailTemplate.html';
  _config.viewportSize = {
    width: _pageWidth + 2*_pageMargin,
    height: 100
  };

  _config.pageImageFormat = 'JPEG';

  // private
  function getGuid() {
    var guid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0,
        v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);

    });
    guid = guid;
    return guid;
  }

  function convertObjectParamsToQuerystring(objParams) {
    var paramsStr = '';
    for (var k in objParams) {
      var v = objParams[k];
      var param = k + '=' + v + '&';
      paramsStr += param;
    }
    return paramsStr;
  }

  function setViewport() {
    _phantomPageInstance.set('viewportSize', {
      width: _config.viewportSize.width,
      height: _config.viewportSize.height
    });
  }

  function getEmailTemplate() {
    return fs.readFileSync(_config.emailTemplateFile).toString();
  }

  function getEmailHtml(regions) {
    html = handlebars.compile(getEmailTemplate())({
      regions: regions,
      url: targetUrl
    });

    return html;
  }

  var _heightToAdd = 0; // assign variable outside to reserve the margin for the last region who doesn't have nextSiblingRegion
  function addSpacingToRegion(regionToCapture, nextSiblingRegion, index) {
    var topToAdd = 0;

    // figure what is the gap between regions
    if (nextSiblingRegion) {
      _heightToAdd = nextSiblingRegion.top - (regionToCapture.top + regionToCapture.height);
    }
    // clip the first region up from original top position
    if (index === 0) { 
      topToAdd = -_pageMargin;
      _heightToAdd += _pageMargin;
    }

    regionToCapture.height += _heightToAdd;
    regionToCapture.left -= _pageMargin;
    regionToCapture.width += (_pageMargin * 2);
    regionToCapture.top += topToAdd;

    // update links position accordingly to the new region position
    updateLinksPosition(regionToCapture.links, {
      height: _heightToAdd,
      left: _pageMargin,
      right: _pageMargin,
      top: topToAdd
    });
  }

  function updateLinksPosition(links, props) {
    for (var i = 0; i < links.length; i++) {
      links[i].left += props.left;
      links[i].right += props.right;
      links[i].top += props.top;
    }
  }

  // generate html and send to the server!
  function uploadRegionsImage(regions) {
    util.log('uploadRegionsImage');
    var deferred = Q.defer();
    var imagesUploadQueue = regions.length;

    regions.forEach(function (region, index) {
      var regionName = 'region' + index;
      util.log('start ' + regionName);

      captureRegion(region, 'PNG')
        .then(function (base64Image) {
          uploadImage(base64Image, 'image/png', regionName)
            .then(function (data) {
              region.imageUrl = data.imageLink;

              imagesUploadQueue--;
              if (imagesUploadQueue === 0) {
                util.log('uploadRegionsImage done');
                deferred.resolve(regions);
              }
            })
            .catch(function(error) {
              util.error(regionName + ': upload error - ' + error);
              _htmlSent = true;
              _error = true;
              endProcess();
            });
        })
        .catch(function (error) {
          util.error(regionName + ': capture error - ' + error);
          _htmlSent = true;
          _error = true;
          endProcess();
        });
    });

    return deferred.promise;
  }

  var uploadImage = function (base64Image, type, name) {
    util.log(name + ': uploadImage');

    var deferred = Q.defer();
    var api_key = 'AIzaSyDUB2NEewMa3-FXE-1ssDcV9jR8KaL6x3E';
    var bucket = 'shoutout-snapshots';
    //var api_key = 'AIzaSyC2I_wYfPM72ldP6yh5DU3Bd20CprZB0ZY';
    //var bucket = 'static.wixstatic.com';
    var urlParams = {
      uploadType: 'media',
      key: api_key,
      predefinedAcl: 'publicRead',
      name: 'snapshot-' + getGuid()
    };

    var queryStringParams = convertObjectParamsToQuerystring(urlParams);
    var api_call = 'https://www.googleapis.com/upload/storage/v1/b/' + bucket + '/o?' + queryStringParams;

    restler
      .request(api_call, {
        method: 'POST',
        data: base64Image,
        multipart: false,
        parser: restler.parsers.json,
        headers: {
          'Content-Type': type,
          'Content-Encoding': 'base64',
          'Access-Control-Allow-Origin': '*'
        }
      })
      .on('complete', function (result, response) {
        if (result instanceof Error) {
          deferred.reject(result);
        }
        else {
          // var imageLink = data.mediaLink;
          var imageUrl = 'http://storage.googleapis.com/' + result.bucket + '/' + result.name;

          util.log(name + ': image was uploaded : ' + imageUrl);

          deferred.resolve({
            imageLink: imageUrl
          });
        }
      });

    return deferred.promise;
  };

  var capturePage = function (imageFormat) {
    util.log('capture full snapshot');
    var deferred = Q.defer();

    _phantomPageInstance.set('clipRect', {});
    _phantomPageInstance.renderBase64(imageFormat, function (base64Image) {
      deferred.resolve(base64Image);
    });

    return deferred.promise;
  };

  var captureRegion = function (region, imageFormat) {
    util.log('capture region');
    var deferred = Q.defer();

    _phantomPageInstance.set('clipRect', {
      top: region.top,
      left: region.left,
      width: region.width,
      height: region.height
    });

    _phantomPageInstance.renderBase64(imageFormat, function (base64Image) {
      deferred.resolve(base64Image);
    });

    return deferred.promise;
  };

  var setMessageSnapshot = function (payload, type) {
    util.log(type + ': setMessageSnapshot');
    var deferred = Q.defer();

    if (_webhook) {
      restler.post(_webhook, {
        data: JSON.stringify(payload),
        headers: {
          'Content-Type': "application/json"
        }
      })
        .on('complete', function (data) {
          deferred.resolve();
          util.log(type + ': setMessageSnapshot complete');
        })
        .on('error', function(error) {
          var msg = type + ': setMessageSnapshot error: ' + error;
          util.error(msg);
          deferred.reject(msg);
        });
    } else {
      _error = true;
      deferred.reject('missing webhook');
    }

    return deferred.promise;
  };

  var getRegions = function () {
    util.log('getRegions');

    var deferred = Q.defer();
    var regions = [];

    regions = _phantomPageInstance.evaluate(function getRegionsData(_pageMargin) {
      var regions = [];
      var composerWidth = $('.lp-composer').width();
      var composerLeft = $('.lp-composer').offset() ? $('.lp-composer').offset().left : _pageMargin;
      var domRegions = document.querySelectorAll('.lp-composer .region, .lp-composer .share-container');
      for (var i = 0; i < domRegions.length; i++) {
        var clipRect = domRegions[i].getBoundingClientRect();
        var region = {
          uid: i.toString(),
          top: clipRect.top,
          left: composerLeft,
          width: composerWidth,
          height: clipRect.height
        };
        region.altText = extractRegionAlt(domRegions[i]);
        region.links = getRegionLinksData(domRegions[i], region);
        regions.push(region);
      }

      function extractRegionAlt(domRegion) {
        var altText = '';
        var viewContainer = angular.element(domRegion).find('.view-container:visible');
        var item = null;
        if (viewContainer.length > 0) {
          item = viewContainer.scope().item;
          switch (item.type) {
          case 'text':
            altText = extractTextRegionAlt(item.data);
            break;
          case 'image':
            altText = extractImageRegionAlt(item.data);
            break;
          case 'link':
            altText = extractLinkRegionAlt(item.data);
            break;
          case 'video':
            altText = extractVideoRegionAlt(item.data);
            break;
          case 'button':
            altText = extractButtonRegionAlt(item.data);
            break;
          }
        }
        return altText;
      }

      function extractButtonRegionAlt(itemData) {
        return itemData.label;
      }

      function extractVideoRegionAlt(itemData) {
        return 'Video';
      }

      function extractLinkRegionAlt(itemData) {
        var altText = 'Link';
        if (itemData.extracted) {
          if (itemData.extracted.title) {
            altText = itemData.extracted.title;
          } else if (itemData.extracted.description) {
            altText = itemData.extracted.description;
          }
        }
        return altText;
      }

      function extractImageRegionAlt(itemData) {
        return "Image";
      }

      function extractTextRegionAlt(itemData) {
        return $(itemData.html).text();
      }

      function getRegionLinksData(domRegion, region) {
        var links;
        if ($(domRegions).hasClass('share-container')) {
          links = $(domRegion).find('a[href]:visible');
        } else {
          links = $(domRegion).find('.view-container a[href]:visible');
        }
        var linksData = [];

        links.each(function (index, link) {
          var linkData = {};
          linkData.url = $(link).prop('href');

          var clipRect = link.getBoundingClientRect();

          // link position relative to the region
          linkData.left = clipRect.left - region.left;
          linkData.top = clipRect.top - region.top;
          linkData.width = clipRect.width;
          linkData.height = clipRect.height;
          linkData.right = linkData.left + linkData.width;
          linkData.bottom = linkData.top + linkData.height;

          linksData.push(linkData);
        });

        return linksData;
      }

      return regions;

    }, function (regions) {
      util.log('getRegions Done');
      deferred.resolve(regions);
    });

    return deferred.promise;
  };

  function endProcess() {
    if (_snapshotSent && _htmlSent) {
      _phantomInstance.exit();
      if (_error) {
        process.exit(1);
      }
      process.exit();
    }
  }

  this.run = function () {
    // failsafe - exit for no reason after 15 sec
    setTimeout(function () {
      util.error("timeout exceeded");
      _phantomInstance.exit();
      process.exit(1);
    }, 30000);

    util.log('open page: ' + targetUrl);

    setViewport();

    _phantomPageInstance.open(targetUrl + '?render=1', function (status) {
      if (status === 'success') {

        // create snapshot of the whole page, upload and set message
        capturePage(_config.pageImageFormat)
          .then(function (base64Image) {
            return uploadImage(base64Image, 'image/jpeg', 'snapshot');
          }).then(function (data) {
            if (_webhook) {
              setMessageSnapshot({
                snapshot: data.imageLink
              }, 'snapshot')
                .then(function(){
                  util.log("snapshot finished");
                  _snapshotSent = true;
                  endProcess();
                })
                .catch(function(error) {
                  util.error('snapshot setMessage error: ' + error);
                  _snapshotSent = true;
                  _error = true;
                  endProcess();
                });
            } else {
              util.error("missing webhook");
              _snapshotSent = true;
              endProcess();
            }
          });

        // create sliced screenshots of the regions
        util.log("create sliced snapshots");
        getRegions().then(function (regions) {
          if (_.isEmpty(regions) === false) {
            regions.forEach(function (region, index) {
              addSpacingToRegion(region, regions[index + 1], index);
            });
            
            uploadRegionsImage(regions)
              .then(function () {
                util.log('getting html template');
                var html = getEmailHtml(regions);
                if (_webhook) {
                  setMessageSnapshot({
                    html: html
                  }, 'html')
                    .then(function () {
                      util.log("worker finished");

                      // util.log('writing template');
                      // fs.writeFileSync("outputTemplate.html", html, {});
                      _htmlSent = true;
                      endProcess();
                    })
                    .catch(function(error) {
                      util.error('regions setMessage error: ' + error);
                      _htmlSent = true;
                      endProcess();
                    });
                } else {
                  util.error("missing webhook");
                  _htmlSent = true;
                  endProcess();
                }
              })
              .catch(function (error) {
                util.error('upload regions error: ' + error);
                _htmlSent = true;
                endProcess();
              });
          } else {
            util.error("no regions found");
            _htmlSent = true;
            _error = true;
            endProcess();
          }
        });
      } else {
        util.error('Unable to load the address!');
        process.exit(1);
      }
    });
  };

  this.init = function () {
    util.log("init phantom");

    var deferred = Q.defer();

    phantom.create(function (ph) {
      _phantomInstance = ph;
      ph.createPage(function (page) {
        _phantomPageInstance = page;
        deferred.resolve(_phantomPageInstance);
      });
    }, {
      binary: './phantomjs'
      //binary: './phantomjs-mac'
    });
    return deferred.promise;
  };

}


function getPayload() {
  var payloadIndex = -1;
  process.argv.forEach(function (val, index, array) {
    if (val == "-payload") payloadIndex = index + 1;
  });
  return JSON.parse(fs.readFileSync(process.argv[payloadIndex]));
}

// var payload = getPayload();
var payload = {
  "url": "http://shoutout.fanta.wixpress.com/lp/26a8fe14-7396-4737-b653-ca166b766ab8",
  "webhook": "http://shoutout.fanta.wixpress.com/api/messages/26a8fe14-7396-4737-b653-ca166b766ab8/snapshot?instance=k9j3cQ-oFWtij3-8RkJgC-j5dKnLgRxb7-5WgM2MALc.eyJpbnN0YW5jZUlkIjoiMTM1YzM3ZWUtMzMyYy01YTkxLWQxYWMtODkyYzkyYzgxYzkyIiwic2lnbkRhdGUiOiIyMDE0LTA2LTExVDA2OjMwOjQ5LjM2OC0wNTowMCIsInVpZCI6ImEzMDZjYmU0LTFmOTEtNGM5ZC1hNWE3LTc3NWU1MzM1OGUxYSIsInBlcm1pc3Npb25zIjoiT1dORVIiLCJpcEFuZFBvcnQiOiJudWxsL251bGwiLCJ2ZW5kb3JQcm9kdWN0SWQiOm51bGwsImRlbW9Nb2RlIjpmYWxzZX0"
};

//==================================================
util.log("worker start");

if (!payload.url) {
  util.error("No url specified");
  process.exit(1);
}

//if (!payload.webhook) {
//  util.error("No webhook specified");
//  process.exit(1);
//}

var snapshotter = new Snapshotter(payload.url, payload.webhook);
snapshotter.init().then(function () {
  snapshotter.run();
});
