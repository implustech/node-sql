'use strict';

var util = require('util');
var assert = require('assert');
var _ = require('lodash');

var Clickhouse = function(config) {
  this.output = [];
  this.params = [];
  this.config = config || {};
};

var Postgres = require('./postgres');

util.inherits(Clickhouse, Postgres);

Clickhouse.prototype._myClass = Clickhouse;

Clickhouse.prototype._quoteCharacter = '`';

Clickhouse.prototype._arrayAggFunctionName = 'GROUP_CONCAT';

Clickhouse.prototype.visitReplace = function(replace) {
  var self = this;
  // don't use table.column for replaces
  this._visitedReplace = true;

  var result = ['REPLACE'];
  result = result.concat(replace.nodes.map(this.visit.bind(this)));
  result.push('INTO ' + this.visit(this._queryNode.table.toNode()));
  result.push('(' + replace.columns.map(this.visit.bind(this)).join(', ') + ')');

  var paramNodes = replace.getParameters();

  if (paramNodes.length > 0) {
    var paramText = paramNodes.map(function (paramSet) {
        return paramSet.map(function (param) {
          return self.visit(param);
        }).join(', ');
      }).map(function (param) {
        return '('+param+')';
      }).join(', ');

    result.push('VALUES', paramText);

    if (result.slice(2, 5).join(' ') === '() VALUES ()') {
      result.splice(2, 3, 'DEFAULT VALUES');
    }
  }

  this._visitedReplace = false;

  if (result[2] === 'DEFAULT VALUES') {
    result[2] = '() VALUES ()';
  }
  return result;
};

Clickhouse.prototype._getParameterPlaceholder = function() {
  return '?';
};

Clickhouse.prototype._getParameterValue = function(value) {
  if (Buffer.isBuffer(value)) {
    value = 'x' + this._getParameterValue(value.toString('hex'));
  } else {
    value = Postgres.prototype._getParameterValue.call(this, value);
  }
  return value;
};

Clickhouse.prototype.visitOnDuplicate = function(onDuplicate) {
  var params = [];
  /* jshint boss: true */
  for(var i = 0, node; node = onDuplicate.nodes[i]; i++) {
    var target_col = this.visit(node);
    params = params.concat(target_col + ' = ' + this.visit(node.value));
  }
  var result = [
    'ON DUPLICATE KEY UPDATE',
    params.join(', ')
  ];
  return result;
};

Clickhouse.prototype.visitOnConflict = function(onConflict) {
  throw new Error('Clickhouse does not allow onConflict clause.');
};

Clickhouse.prototype.visitReturning = function() {
  throw new Error('Clickhouse does not allow returning clause.');
};

Clickhouse.prototype.visitForShare = function() {
  throw new Error('Clickhouse does not allow FOR SHARE clause.');
};

Clickhouse.prototype.visitCreate = function(create) {
  var result = Clickhouse.super_.prototype.visitCreate.call(this, create);
  var engine = this._queryNode.table._initialConfig.engine;
  var charset = this._queryNode.table._initialConfig.charset;

  if ( !! engine) {
    result.push('ENGINE=' + engine);
  }

  if ( !! charset) {
    result.push('DEFAULT CHARSET=' + charset);
  }

  return result;
};

Clickhouse.prototype.visitRenameColumn = function(renameColumn) {
  var dataType = renameColumn.nodes[1].dataType || renameColumn.nodes[0].dataType;
  assert(dataType, 'dataType missing for column ' + (renameColumn.nodes[1].name || renameColumn.nodes[0].name || '') +
    ' (CHANGE COLUMN statements require a dataType)');
  return ['CHANGE COLUMN ' + this.visit(renameColumn.nodes[0]) + ' ' + this.visit(renameColumn.nodes[1]) + ' ' + dataType];
};

Clickhouse.prototype.visitInsert = function(insert) {
  var result = Postgres.prototype.visitInsert.call(this, insert);
  if (result[2] === 'DEFAULT VALUES') {
    result[2] = '() VALUES ()';
  }
  return result;
};

Clickhouse.prototype.visitIndexes = function(node) {
  var tableName = this.visit(this._queryNode.table.toNode())[0];

  return "SHOW INDEX FROM " + tableName;
};

Clickhouse.prototype.visitBinary = function(binary) {
  if (binary.operator === '@@') {
    var self = this;
    var text = '(MATCH ' + this.visit(binary.left) + ' AGAINST ';
    text += this.visit(binary.right);
    text += ')';
    return [text];
  }
  return Clickhouse.super_.prototype.visitBinary.call(this, binary);
};

Clickhouse.prototype.visitFunctionCall = function(functionCall) {
  var _this=this;

  this._visitingFunctionCall = true;

  function _extract() {
    var nodes = functionCall.nodes.map(_this.visit.bind(_this));
    if (nodes.length != 1) throw new Error('Not enough parameters passed to ' + functionCall.name + ' function');
    var displayName = Clickhouse.functionMap.hasOwnProperty(functionCall.name) ? Clickhouse.functionMap[functionCall.name] : functionCall.name;
    var txt = displayName + '(' + (nodes[0]+'') + ')';
    return txt;
  }

  var txt="";
  var name = functionCall.name;
  var displayName = Clickhouse.functionMap.hasOwnProperty(functionCall.name) ? Clickhouse.functionMap[functionCall.name] : functionCall.name;
  // Override date functions since Clickhouse is different than postgres
  if (['YEAR', 'MONTH', 'DAY', 'HOUR'].indexOf(functionCall.name) >= 0) txt = _extract();
  // Override CURRENT_TIMESTAMP function to remove parens
  else if ('CURRENT_TIMESTAMP' == functionCall.name) txt = functionCall.name;
  else txt = displayName + '(' + functionCall.nodes.map(this.visit.bind(this)).join(', ') + ')';

    this._visitingFunctionCall = false;
  return [txt];
};

Clickhouse.prototype.visitColumn = function(columnNode) {

  // Clichouse does not support tablename.columnName
  delete columnNode.table;

  var self = this;
  var inSelectClause;

  function isCountStarExpression(columnNode){
    if (!columnNode.aggregator) return false;
    if (columnNode.aggregator.toLowerCase()!='count') return false;
    if (!columnNode.star) return false;
    return true;
  }

  function _countStar(){
    // Implement our own
    var result='COUNT()';
    if(inSelectClause && columnNode.alias) {
      result += ' AS ' + self.quote(columnNode.alias);
    }
    return result;
  }

  inSelectClause = !this._selectOrDeleteEndIndex;
  if(isCountStarExpression(columnNode)) return _countStar();
  return Clickhouse.super_.prototype.visitColumn.call(this, columnNode);
};

Clickhouse.prototype.visitInterval = function(interval) {
  var parameter;
  if(_.isNumber(interval.years)) {
    if(_.isNumber(interval.months)) {
      parameter = "'" + interval.years + '-' + interval.months + "' YEAR_MONTH";
    } else {
      parameter = interval.years + ' YEAR';
    }
  } else if(_.isNumber(interval.months)) {
    parameter = interval.months + ' MONTH';
  } else if(_.isNumber(interval.days)) {
    parameter = "'" + interval.days + ' ' +
      (_.isNumber(interval.hours)?interval.hours:0) + ':' +
      (_.isNumber(interval.minutes)?interval.minutes:0) + ':' +
      (_.isNumber(interval.seconds)?interval.seconds:0) + "' DAY_SECOND";
  } else {
    parameter = "'" + (_.isNumber(interval.hours)?interval.hours:0) + ':' +
      (_.isNumber(interval.minutes)?interval.minutes:0) + ':' +
      (_.isNumber(interval.seconds)?interval.seconds:0) + "' HOUR_SECOND";
  }
  var result = "INTERVAL " + parameter;
  return result;
};

Clickhouse.prototype.visitAlter = function(alter) {
  throw new Error('Not Implemented');
};

Clickhouse.prototype.visitArrayCall = function(arrayCall) {
  var txt = '[' + arrayCall.nodes.map(this.visit.bind(this)).join(', ') + ']';
  return [txt];
};

Clickhouse.prototype.visitFrom = function(from) {
  var result = [];
  if (from.skipFromStatement) {
    result.push(',');
  } else {
    result.push('FROM');
  }
  for(var i = 0; i < from.nodes.length; i++) {
    // Currently clickhouse only support single table, but anyway
    result = result.concat(this.visit(from.nodes[i], {"parentIsFrom": true}));
  }
  return result;
};

Clickhouse.prototype.visitJoin = function(join, config) {
  var result = [];
  var parentIsFrom = config && config.parentIsFrom;
  this._visitingJoin = true;
  if (parentIsFrom) {
      result = result.concat('(');
  }

  result = result.concat(this.visit(join.from, {"joinFromQuery": true}));
  result = result.concat('ALL ' + join.subType + ' JOIN');
  result = result.concat(this.visit(join.to));
  result = result.concat('USING');
  result = result.concat(this.visit(join.on));
  if (parentIsFrom) {
      result = result.concat(')');
  }

  return result;
};

Clickhouse.functionMap = {
  "ROUND": "round",
  "TODAY": "today",
  "NOW": "now",
  "ARRAY_JOIN": "arrayJoin"
};

module.exports = Clickhouse;
