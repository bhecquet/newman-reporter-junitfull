var _ = require('lodash'),
xml = require('xmlbuilder'),
moment = require('moment'),
JunitFullReporter;

// JUnit Reporter based on XSD specified by Publish Test Results task for Azure Pipeline / TFS 2018 / TFS 2017 and TFS 2015
// Source: https://docs.microsoft.com/en-us/azure/devops/pipelines/tasks/test/publish-test-results?view=vsts&tabs=yaml
// XSD: https://github.com/windyroad/JUnit-Schema/blob/master/JUnit.xsd

const SEPARATOR = '->';
const REQ_NAME_KEY = '__name__'

/**
 * Resolves the parent qualified name for the provided item
 *
 * @param {PostmanItem|PostmanItemGroup} item The item for which to resolve the full name
 * @param {?String} [separator=SEP] The separator symbol to join path name entries with
 * @returns {String} The full name of the provided item, including prepended parent item names
 * @private
 */
function getParentName (item, separator) {
    if (_.isEmpty(item) || !_.isFunction(item.parent) || !_.isFunction(item.forEachParent)) { 
		return; 
	}

    var chain = [];
	
    item.forEachParent(function (parent) { 
		chain.unshift(parent.name || parent.id); 
	});
	
    return chain.join(_.isString(separator) ? separator : SEPARATOR);
}

/**
 * A function that creates raw XML to be written to Newman JUnit reports.
 *
 * @param {Object} newman - The collection run object, with a event handler setter, used to enable event wise reporting.
 * @param {Object} reporterOptions - A set of JUnit reporter run options.
 * @param {String=} reporterOptions.export - Optional custom path to create the XML report at.
 * @returns {*}
 */
JunitFullReporter = function (newman, reporterOptions, options) {
	
    
	newman.on('beforeDone', function () {
		
		
		var excludeRequestNames = []
		if (reporterOptions.excludeRequest) {
			excludeRequestNames = reporterOptions.excludeRequest.split(',')
		}
		var executions = _.get(newman, 'summary.run.executions'),
		    globalValues = _.get(newman, 'summary.globals.values.members', []),
		    environmentValues = _.get(newman, 'summary.environment.values.members', []),
		    collection = _.get(newman, 'summary.collection'),
		    root;
		
		
		//console.log(newman.summary.run.executions[0])
		var date = moment(new Date()).local().format('YYYY-MM-DDTHH:mm:ss.SSS');

        if (!executions) {
            return;
        }

        root = xml.create('testsuites', { version: '1.0', encoding: 'UTF-8' });
		root.att('name', collection.name);
        root.att('tests', _.get(newman, 'summary.run.stats.tests.total', 'unknown'));

		var failuresTotal = 0, errorsTotal = 0;

		// Process executions (testsuites)
		_.forEach(executions, function (execution) {
			
			// exclude requests as requested by user
			if (excludeRequestNames.includes(execution.item.name)) {
				return
			}
			
			var iterationName = 'Iteration ' + execution.cursor.iteration.toString()
			var testsuite = root.ele('testsuite');
			var failures = 0, errors = 0;
			var propertyValues = _.merge(environmentValues, globalValues);
			var requestName = execution.item.name
			
			// Process properties
			if (propertyValues && propertyValues.length) {
				properties = testsuite.ele('properties');
			
				_.forEach(propertyValues, function (propertyItem) {
					
					// do not log overriden name '__name__' properties
					if (propertyItem.key.toLowerCase().startsWith(REQ_NAME_KEY)) {
						// request name: __name__<id_iteration><request_name>
						if (propertyItem.value != null
							&& propertyItem.value.trim() !== '' 
							&& propertyItem.key.toLowerCase() === REQ_NAME_KEY + execution.cursor.iteration + execution.item.name.toLowerCase()) {
							requestName = propertyItem.value;
							
						// iteration name: __name__<id_iteration>
						} else if (propertyItem.value != null
							&& propertyItem.value.trim() !== '' 
							&& propertyItem.key.toLowerCase() === REQ_NAME_KEY + execution.cursor.iteration) {
							iterationName = propertyItem.value;
						}
						return
					}
					
					if (reporterOptions.hideSensitiveData && 
						(
						propertyItem.key.toLowerCase().includes("user")
						|| propertyItem.key.toLowerCase().includes("token")
						|| propertyItem.key.toLowerCase().includes("password")
						|| propertyItem.key.toLowerCase().includes("pwd")
						|| propertyItem.key.toLowerCase().includes("passwd")
						|| propertyItem.key.toLowerCase().includes("usr")
						)) {
						return
					}						
					var property = properties.ele('property');
					property.att('name', propertyItem.key);
                    
					if (propertyItem.value === null) {
						propertyItem.value = "";
					}
                    
					property.att('value', propertyItem.value.toString().substring(0, 70));
				});
			}
				
            testsuite.att('id', (execution.cursor.iteration * execution.cursor.length) + execution.cursor.position);
			
			// Hostname
			var protocol = _.get(execution, 'request.url.protocol', 'https') + '://';
			var hostName = _.get(execution, 'request.url.host', ['localhost']);

			testsuite.att('hostname', protocol + hostName.join('.'));
			
			// Package
			var packageName = getParentName(execution.item)
			if (execution.cursor.cycles > 1) {
					if (packageName) {
							testsuite.att('package', iterationName + SEPARATOR + packageName);
					} else {
							testsuite.att('package', iterationName);
					}
			} else {
							testsuite.att('package', getParentName(execution.item));
			}


			
			// Name
			testsuite.att('name', requestName);
			
			// Tests
			if (execution.assertions) {
				testsuite.att('tests', execution.assertions.length);
			}
			else {
				testsuite.att('tests', 0);
			}
			
			// Timestamp
			testsuite.att('timestamp', date);
			
			// Time
			testsuite.att('time', (_.get(execution, 'response.responseTime') / 1000 || 0).toFixed(3));
			
			// Timestamp (add time)
			date = moment(date).add(_.get(execution, 'response.responseTime'), 'ms').local().format('YYYY-MM-DDTHH:mm:ss.SSS');
			

			// Process assertions (testcases)
			_.forEach(['prerequestScript', 'assertions', 'testScript'], function (property) {
				_.forEach(execution[property], function (testExecution) {
					var testcase = testsuite.ele('testcase');
					
					// Classname
					var className = [];
					className.push(_.get(testcase.up(), 'attributes.package.value')); // Only populated with -n 2 (or more)
					className.push(collection.name)
					className.push(_.get(testcase.up(), 'attributes.name.value')); // Potentially pulls in hierarchical naming convention
					testcase.att('classname', className.join(SEPARATOR));
					
					if (property === 'assertions') {
						// Name
						var testAndAssertionName = [requestName, testExecution.assertion];
						testcase.att('name', testAndAssertionName.join(SEPARATOR));
						
						// Time (testsuite time divided by number of assertions)
						testcase.att('time', (_.get(testcase.up(), 'attributes.time.value') / execution.assertions.length || 0).toFixed(3));
					
					} else {
						// Name
						testcase.att('name', property === 'testScript' ? 'Tests' : 'Pre-request Script');
					}
					
					// Errors / Failures
					var errorItem = testExecution.error;
					if (errorItem) {
						var result;
						if (property !== 'assertions') {
							// Error
							++errors;
							result = testcase.ele('error');
							
							if (errorItem.stacktrace) {
								result.dat(errorItem.stacktrace);
							}
						} else {
							// Failure
							++failures;
							result = testcase.ele('failure');
							result.dat(errorItem.stack);
						}
						
						result.att('type', errorItem.name);
						result.att('message', errorItem.message);
					}
				});
			});
			
			// Failures
			testsuite.att('failures', failures);
			failuresTotal += failures;
			
			// Errors
			testsuite.att('errors', errors);
			errorsTotal += errors;
		});
		
        // Total failures and errors across all test suites
        // Add flag --reporter-xunit-aggregate to trigger
        if (reporterOptions.aggregate) {
            root.att('failures', failuresTotal);
            root.att('errors', errorsTotal);
        }

        newman.exports.push({
            name: 'junit-reporter-full',
            default: 'newman-run-report-full.xml',
            path: reporterOptions.export,
            content: root.end({
                pretty: true,
                indent: '  ',
                newline: '\n',
                allowEmpty: false
            })
        });
    });
};

module.exports = JunitFullReporter;
