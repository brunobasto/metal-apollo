import {parser, DocumentType} from './parser';
import Component from 'metal-jsx';

const invariant = require('invariant');
const assign = require('object-assign');
const pick = require('lodash/pick');
const hoistNonReactStatics = require('hoist-non-react-statics');

const defaultMapPropsToOptions = () => ({});
const defaultMapResultToProps = props => props;
const defaultMapPropsToSkip = () => false;

function observableQueryFields(observable) {
	const fields = pick(
		observable,
		'variables',
		'refetch',
		'fetchMore',
		'updateQuery',
		'startPolling',
		'stopPolling',
		'subscribeToMore'
	);

	Object.keys(fields).forEach(key => {
		if (typeof fields[key] === 'function') {
			fields[key] = fields[key].bind(observable);
		}
	});

	return fields;
}

function getDisplayName(WrappedComponent) {
	return WrappedComponent.displayName || WrappedComponent.name || 'Component';
}

export default function graphql(document, operationOptions) {
	const {
		options = defaultMapPropsToOptions,
		skip = defaultMapPropsToSkip,
		alias = 'Apollo',
	} = operationOptions;

	const mapPropsToOptions = (props, context) => {
		if (typeof options === 'function') {
			return assign({}, props, options(props, context));
		}

		return assign({}, props, options);
	};

	const mapPropsToSkip = skip;

	const mapResultToProps = operationOptions.props;

	// safety check on the operation

	const operation = parser(document);

	function wrapWithApolloComponent(WrappedComponent) {
		const graphQLDisplayName = `${alias}(${getDisplayName(
			WrappedComponent
		)})`;

		class GraphQL extends Component {
			static displayName = graphQLDisplayName;

			created() {
				this.type = operation.type;
				this.childMutationData = this.childMutationData.bind(this);
			}

			attached() {
				this.hasMounted = true;
				if (this.type === DocumentType.Mutation) return;

				if (!this.shouldSkip(this.props)) {
					this.subscribeToQuery();
					// call any stacked refetch functions

					if (this.refetcherQueue) {
						const {args, resolve, reject} = this.refetcherQueue;

						this.queryObservable
							.refetch(args)
							.then(resolve)
							.catch(reject);
					}
				}
			}

			willReceiveProps(nextProps) {
				let props = {};

				Object.keys(nextProps).forEach(key => {
					props[key] = nextProps[key].newVal;
				});
				props = assign({}, this.props, props);
				if (this.type === DocumentType.Mutation) {
					return;
				}
				this.updateQuery(props);
				this.resubscribeToQuery();
			}

			disposed() {
				if (this.type === DocumentType.Query) {
					// Recycle the query observable if there ever was one.

					if (this.queryObservable) {
						const recycler = this.getQueryRecycler();

						if (recycler) {
							recycler.recycle(this.queryObservable);
							delete this.queryObservable;
						}
					}

					// It is critical that this happens prior to recyling the query
					// if not it breaks the loading state / network status because
					// an orphan observer is created in AC (intended) which is cleaned up
					// when the browser has time via a setTimeout(0)
					// Unsubscribe from our query subscription.

					this.unsubscribeFromQuery();
				}

				if (this.type === DocumentType.Subscription) {
					this.unsubscribeFromQuery();
				}

				this.hasMounted = false;
			}

			getQueryRecycler() {
				return (
					this.context.getQueryRecycler &&
					this.context.getQueryRecycler(GraphQL)
				);
			}

			getClient() {
				return this.context.client;
			}

			calculateOptions(props = this.props, newOpts) {
				let opts = mapPropsToOptions(props, this.context);

				if (newOpts && newOpts.variables) {
					newOpts.variables = assign(
						{},
						opts.variables,
						newOpts.variables
					);
				}
				if (newOpts) opts = assign({}, opts, newOpts);

				if (opts.variables || !operation.variables.length) return opts;

				const variables = {};

				for (const {variable, type} of operation.variables) {
					if (!variable.name || !variable.name.value) continue;

					if (typeof props[variable.name.value] !== 'undefined') {
						variables[variable.name.value] =
							props[variable.name.value];
						continue;
					}

					// allow optional props

					if (type.kind !== 'NonNullType') {
						variables[variable.name.value] = null;
						continue;
					}

					invariant(
						typeof props[variable.name.value] !== 'undefined',
						`The operation '${
							operation.name
						}' wrapping '${getDisplayName(WrappedComponent)}' ` +
							`is expecting a variable: '${
								variable.name.value
							}' but it was not found in the props ` +
							`passed to '${graphQLDisplayName}'`
					);
				}
				opts = {...opts, variables};

				return opts;
			}

			calculateResultProps(result) {
				let name =
					this.type === DocumentType.Mutation ? 'mutate' : 'data';

				if (operationOptions.name) name = operationOptions.name;

				const newResult = {
					[name]: result,
					ownProps: this.props,
				};

				if (mapResultToProps) {
					return mapResultToProps(newResult, this.context);
				}

				return {[name]: defaultMapResultToProps(result)};
			}

			maybeCreateQuery() {
				if (this.queryObservable) {
					return;
				}
				if (this.type === DocumentType.Mutation) {
					return;
				}

				// Create the observable but don't subscribe yet. The query won't
				// fire until we do.

				const opts = this.calculateOptions(this.props);

				this.createQuery(opts);
			}

			createQuery(opts, props = this.props) {
				if (this.type === DocumentType.Subscription) {
					this.queryObservable = this.getClient(props).subscribe(
						assign({query: document}, opts)
					);
				}
				else {
					// Try to reuse an `ObservableQuery` instance from our recycler. If
					// we get null then there is no instance to reuse and we should
					// create a new `ObservableQuery`. Otherwise we will use our old one.

					const recycler = this.getQueryRecycler();
					let queryObservable = null;

					if (recycler) queryObservable = recycler.reuse(opts);

					if (queryObservable === null) {
						this.queryObservable = this.getClient(props).watchQuery(
							assign(
								{
									query: document,
									metadata: {
										metalComponent: {
											displayName: graphQLDisplayName,
										},
									},
								},
								opts
							)
						);
					}
					else {
						this.queryObservable = queryObservable;
					}
				}
			}

			updateQuery(props) {
				const opts = this.calculateOptions(props);

				// if we skipped initially, we may not have yet created the observable

				if (!this.queryObservable) {
					this.createQuery(opts, props);
				}

				if (this.queryObservable._setOptionsNoResult) {
					// Since we don't care about the result, use a hacky version to
					// work around https://github.com/apollostack/apollo-client/pull/694
					// This workaround is only present in Apollo Client 0.4.21

					this.queryObservable._setOptionsNoResult(opts);
				}
				else {
					if (this.queryObservable.setOptions) {
						this.queryObservable
							.setOptions(opts)
							// The error will be passed to the child container, so we don't
							// need to log it here. We could conceivably log something if
							// an option was set. OTOH we don't log errors w/ the original
							// query. See https://github.com/apollostack/react-apollo/issues/404

							.catch(() => null);
					}
				}
			}

			subscribeToQuery() {
				if (this.querySubscription) {
					return;
				}

				const next = results => {
					if (this.type === DocumentType.Subscription) {
						// Subscriptions don't currently support `currentResult`, so we
						// need to do this ourselves

						this.lastSubscriptionData = results;
					}
					const clashingKeys = Object.keys(
						observableQueryFields(results.data)
					);

					invariant(
						clashingKeys.length === 0,
						`${`the result of the '${graphQLDisplayName}' operation contains ` +
							'keys that conflict with the return object.'}${clashingKeys
							.map(k => `'${k}'`)
							.join(', ')} not allowed.`
					);
					this.forceRenderChildren();
				};

				const handleError = error => {
					// this.resubscribeToQuery();
					// Quick fix for https://github.com/apollostack/react-apollo/issues/378

					if (error.hasOwnProperty('graphQLErrors')) {
						return next({error});
					}
					throw error;
				};

				this.querySubscription = this.queryObservable.subscribe({
					next,
					error: handleError,
				});
			}

			unsubscribeFromQuery() {
				if (this.querySubscription) {
					this.querySubscription.unsubscribe();
					delete this.querySubscription;
				}
			}

			resubscribeToQuery() {
				const lastSubscription = this.querySubscription;

				if (lastSubscription) {
					delete this.querySubscription;
				}
				const {lastError, lastResult} = this.queryObservable;

				this.subscribeToQuery();
				Object.assign(this.queryObservable, {lastError, lastResult});
				if (lastSubscription) {
					lastSubscription.unsubscribe();
				}
			}

			shouldSkip(props = this.props) {
				return mapPropsToSkip(props);
			}

			forceRenderChildren() {
				if (this.hasMounted) {
					this.forceUpdate();
				}
			}

			childMutationData(mutationOpts) {
				const opts = this.calculateOptions(this.props, mutationOpts);

				if (typeof opts.variables === 'undefined') {
					delete opts.variables;
				}

				opts.update = mutationOpts.update;

				opts.mutation = document;

				return this.getClient(this.props).mutate(opts);
			}

			dataForChild() {
				if (this.type === DocumentType.Mutation) {
					return this.childMutationData;
				}

				const opts = this.calculateOptions(this.props);
				const data = {};

				assign(data, observableQueryFields(this.queryObservable));

				if (this.type === DocumentType.Subscription) {
					assign(
						data,
						{
							loading: !this.lastSubscriptionData,
							variables: opts.variables,
						},
						this.lastSubscriptionData &&
							this.lastSubscriptionData.data
					);
				}
				else {
					// fetch the current result (if any) from the store

					const currentResult = this.queryObservable.currentResult();
					// debugger;

					const {loading, error, networkStatus} = currentResult;

					assign(data, {loading, networkStatus});

					// Define the error property on the data object. If the user does
					// not get the error object from `data` within 10 milliseconds
					// then we will log the error to the console.
					//
					// 10 milliseconds is an arbitrary number picked to work around any
					// potential asynchrony in React rendering. It is not super important
					// that the error be logged ASAP, but 10 ms is enough to make it
					// _feel_ like it was logged ASAP while still tolerating asynchrony.

					const logErrorTimeoutId = setTimeout(() => {
						if (error) {
							console.error(
								`Unhandled (in react-apollo:${graphQLDisplayName})`,
								error.stack || error
							);
						}
					}, 10);

					Object.defineProperty(data, 'error', {
						configurable: true,
						enumerable: true,
						get: () => {
							clearTimeout(logErrorTimeoutId);

							return error;
						},
					});

					if (loading) {
						// while loading, we should use any previous data we have

						assign(data, this.previousData, currentResult.data);
					}
					else if (error) {
						// if there is error, use any previously cached data

						assign(
							data,
							(this.queryObservable.getLastResult() || {}).data
						);
					}
					else {
						assign(data, currentResult.data);
						this.previousData = currentResult.data;
					}

					// handle race condition where refetch is called on child mount

					if (!this.querySubscription) {
						data.refetch = args => {
							return new Promise((r, f) => {
								this.refetcherQueue = {
									resolve: r,
									reject: f,
									args,
								};
							});
						};
					}
				}

				return data;
			}

			render() {
				if (this.shouldSkip()) {
					return (
						<WrappedComponent {...this.props}>
							{this.props.children}
						</WrappedComponent>
					);
				}

				this.maybeCreateQuery();

				const {props} = this;
				const data = this.dataForChild();
				const clientProps = this.calculateResultProps(data);
				const mergedPropsAndData = {
					...props,
					...clientProps,
					elementClasses: undefined,
					visible: undefined,
				};

				return (
					<WrappedComponent {...mergedPropsAndData}>
						{this.props.children}
					</WrappedComponent>
				);
			}
		}

		// Make sure we preserve any custom statics on the original component.

		return hoistNonReactStatics(GraphQL, WrappedComponent);
	}

	return wrapWithApolloComponent;
}
