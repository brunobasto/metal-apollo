const shallowEqual = require('fbjs/lib/shallowEqual');

export class ObservableQueryRecycler {
	constructor() {
		this.observableQueries = [];
	}

	recycle(observableQuery) {
		observableQuery.setOptions({
			fetchPolicy: 'standby',
			pollInterval: 0,
			fetchResults: false,
		});

		this.observableQueries.push({
			observableQuery,
			subscription: observableQuery.subscribe({}),
		});
	}

	reuse(options) {
		if (this.observableQueries.length <= 0) {
			return null;
		}

		const item = this.observableQueries.pop();

		if (!item) {
			return null;
		}
		const {observableQuery, subscription} = item;

		subscription.unsubscribe();

		const {...modifiableOpts} = options;

		if (
			!shallowEqual(
				modifiableOpts.variables || {},
				observableQuery.variables
			)
		) {
			return null;
		}

		observableQuery.setOptions({
			...modifiableOpts,
			pollInterval: options.pollInterval,
			fetchPolicy: options.fetchPolicy,
		});

		return observableQuery;
	}
}
