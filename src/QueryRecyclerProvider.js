import Component from 'metal-jsx';
import {ObservableQueryRecycler} from './queryRecycler';

class QueryRecyclerProvider extends Component {
	created() {
		this.recyclers = new WeakMap();
		this.getQueryRecycler = this.getQueryRecycler.bind(this);
	}

	willReceiveProps(nextProps) {
		if (
			nextProps.client &&
			this.context.client !== nextProps.client.newVal
		) {
			this.recyclers = new WeakMap();
		}
	}

	getQueryRecycler(component = Component) {
		if (!this.recyclers.has(component)) {
			this.recyclers.set(component, new ObservableQueryRecycler());
		}

		return this.recyclers.get(component);
	}

	getChildContext() {
		return {
			client: this.context.client,
			getQueryRecycler: this.getQueryRecycler,
		};
	}

	render() {
		return this.props.children;
	}
}

export default QueryRecyclerProvider;
